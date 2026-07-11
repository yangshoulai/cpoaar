import { RegisterNode, NodeResult } from "../core/flow.js";
import { waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";
import { XAI_SIGN_IN_URL } from "./xaiHelpers.js";

const logger = createLogger("node.xai-signin");
const TURNSTILE_WAIT_TIMEOUT_MS = 120000;
const LOGIN_AFTER_CLICK_FAST_WAIT_MS = 10000;
const LOGIN_AFTER_CLICK_FOLLOWUP_WAIT_MS = 35000;
const LOGIN_SUBMIT_MAX_ATTEMPTS = 3;

export class XAiSignInNode extends RegisterNode {
  static name = "xai_sign_in";
  static statuses = {
    success: "xai_sign_in_completed"
  };

  constructor() {
    super(XAiSignInNode.name, "xAI 登录");
  }

  async execute(ctx) {
    const account = ctx.state.account || {};
    const emailAddress = String(account.emailAddress || ctx.state.emailAccount?.emailAddress || "").trim();
    if (!emailAddress) {
      return NodeResult.fail("xai_sign_in_account_missing", "缺少 xAI 授权邮箱");
    }

    const password = resolvePassword(ctx);
    if (!password) {
      return NodeResult.fail(
        "xai_sign_in_password_missing",
        "缺少 xAI 登录密码：请选择带密码的历史记录，或在 xAI 账号配置中设置固定密码"
      );
    }
    ctx.state.account = {
      ...account,
      emailAddress,
      password
    };

    logger.info("打开 xAI 登录页面", { email: emailAddress });
    await ctx.tabs.open(XAI_SIGN_IN_URL);

    const emailInputReady = await waitForAnyCondition([
      {
        name: "account_url",
        check: () => getXAiAccountUrl(ctx)
      },
      {
        name: "email_input",
        check: () => ctx.tabs.query("input[type='email']")
      }
    ], {
      timeoutMs: 30000,
      label: "xAI 登录邮箱输入框",
      signal: ctx.signal
    });
    if (emailInputReady.name === "account_url") {
      logger.info("xAI 已处于登录状态", { email: emailAddress, currentUrl: emailInputReady.value });
      return NodeResult.ok(XAiSignInNode.statuses.success, {
        account: ctx.state.account,
        currentUrl: emailInputReady.value
      });
    }
    if (!emailInputReady.matched) {
      return NodeResult.fail("xai_sign_in_email_input_missing", `未找到 xAI 登录邮箱输入框: ${await ctx.tabs.getCurrentUrl()}`);
    }

    const fillEmailResult = await ctx.tabs.fill("input[type='email']", emailAddress);
    if (!fillEmailResult.ok) {
      return NodeResult.fail("xai_sign_in_email_input_missing", "xAI 登录邮箱输入失败");
    }

    const nextReady = await waitForSignInSubmitButton(ctx, "xAI 登录下一步按钮");
    if (!nextReady.matched) {
      return NodeResult.fail("xai_sign_in_next_submit_failed", "xAI 登录下一步按钮不可用");
    }
    const nextResult = await clickSignInSubmitButton(ctx);
    if (!nextResult.ok) {
      return NodeResult.fail("xai_sign_in_next_submit_failed", "xAI 登录下一步按钮点击失败");
    }

    const passwordStage = await waitForAnyCondition([
      {
        name: "account_url",
        check: () => getXAiAccountUrl(ctx)
      },
      {
        name: "password_input",
        check: () => ctx.tabs.query("input[name='password']")
      },
      {
        name: "turnstile",
        check: () => detectTurnstile(ctx)
      }
    ], {
      timeoutMs: 30000,
      label: "xAI 登录密码输入框",
      signal: ctx.signal
    });
    if (passwordStage.name === "account_url") {
      logger.info("xAI 登录已完成", { email: emailAddress, currentUrl: passwordStage.value });
      return NodeResult.ok(XAiSignInNode.statuses.success, {
        account: ctx.state.account,
        currentUrl: passwordStage.value
      });
    }
    if (!passwordStage.matched) {
      return NodeResult.fail("xai_sign_in_password_input_missing", `未找到 xAI 登录密码输入框: ${await ctx.tabs.getCurrentUrl()}`);
    }

    if (passwordStage.name === "turnstile") {
      const turnstileBeforePassword = await waitForTurnstileIfPresent(ctx);
      if (!turnstileBeforePassword.ok) {
        return NodeResult.fail("xai_sign_in_turnstile_timeout", turnstileBeforePassword.error || "等待 xAI 登录 Turnstile 完成超时", {
          turnstile: turnstileBeforePassword
        });
      }
      const passwordInputReady = await waitForAnyCondition([
        {
          name: "password_input",
          check: () => ctx.tabs.query("input[name='password']")
        }
      ], {
        timeoutMs: 30000,
        label: "xAI 登录密码输入框",
        signal: ctx.signal
      });
      if (!passwordInputReady.matched) {
        return NodeResult.fail("xai_sign_in_password_input_missing", `Turnstile 完成后仍未找到 xAI 登录密码输入框: ${await ctx.tabs.getCurrentUrl()}`);
      }
    }

    const fillPasswordResult = await ctx.tabs.fill("input[name='password']", password);
    if (!fillPasswordResult.ok) {
      return NodeResult.fail("xai_sign_in_password_input_missing", "xAI 登录密码输入失败");
    }

    const turnstileResult = await waitForTurnstileIfPresent(ctx);
    if (!turnstileResult.ok) {
      return NodeResult.fail("xai_sign_in_turnstile_timeout", turnstileResult.error || "等待 xAI 登录 Turnstile 完成超时", {
        turnstile: turnstileResult
      });
    }

    const accountReady = await submitLoginAndWaitForAccount(ctx, password);
    if (!accountReady.ok) {
      return NodeResult.fail(accountReady.status, accountReady.error, accountReady.data || {});
    }

    logger.info("xAI 登录完成", {
      email: emailAddress,
      currentUrl: accountReady.value
    });
    return NodeResult.ok(XAiSignInNode.statuses.success, {
      account: ctx.state.account,
      currentUrl: accountReady.value
    });
  }
}

async function submitLoginAndWaitForAccount(ctx, password) {
  for (let attempt = 1; attempt <= LOGIN_SUBMIT_MAX_ATTEMPTS; attempt += 1) {
    await ensurePasswordInputValue(ctx, password);

    const loginReady = await waitForSignInSubmitButton(ctx, "xAI 登录按钮");
    if (!loginReady.matched) {
      return {
        ok: false,
        status: "xai_sign_in_login_submit_failed",
        error: "xAI 登录按钮不可用"
      };
    }
    const loginResult = await clickSignInSubmitButton(ctx);
    if (!loginResult.ok) {
      return {
        ok: false,
        status: "xai_sign_in_login_submit_failed",
        error: "xAI 登录按钮点击失败"
      };
    }

    logger.info("xAI 登录按钮已点击，等待跳转或 Turnstile", {
      attempt,
      maxAttempts: LOGIN_SUBMIT_MAX_ATTEMPTS,
      button: loginResult.button
    });

    const fastResult = await waitForAccountUrlAfterClick(ctx, LOGIN_AFTER_CLICK_FAST_WAIT_MS);
    if (fastResult.name === "account_url") {
      return {
        ok: true,
        currentUrl: fastResult.value
      };
    }
    if (await detectTurnstile(ctx)) {
      const turnstileResult = await handlePostLoginTurnstile(ctx, attempt);
      if (!turnstileResult.ok) {
        return turnstileResult;
      }
      continue;
    }

    const followupResult = await waitForAccountUrlAfterClick(ctx, LOGIN_AFTER_CLICK_FOLLOWUP_WAIT_MS);
    if (followupResult.name === "account_url") {
      return {
        ok: true,
        currentUrl: followupResult.value
      };
    }
    if (await detectTurnstile(ctx)) {
      const turnstileResult = await handlePostLoginTurnstile(ctx, attempt);
      if (!turnstileResult.ok) {
        return turnstileResult;
      }
      continue;
    }

    const currentUrl = await ctx.tabs.getCurrentUrl();
    logger.warn("xAI 登录点击后未跳转到 account，且未检测到 Turnstile", {
      attempt,
      maxAttempts: LOGIN_SUBMIT_MAX_ATTEMPTS,
      currentUrl
    });
    return {
      ok: false,
      status: "xai_sign_in_failed",
      error: `xAI 登录后未进入 account 页面: ${currentUrl}`
    };
  }

  return {
    ok: false,
    status: "xai_sign_in_failed",
    error: `xAI 登录后多次处理 Turnstile 仍未进入 account 页面: ${await ctx.tabs.getCurrentUrl()}`
  };
}

async function waitForAccountUrlAfterClick(ctx, timeoutMs) {
  return waitForAnyCondition([
    {
      name: "account_url",
      check: () => getXAiAccountUrl(ctx)
    }
  ], {
    timeoutMs,
    intervalMs: 500,
    label: "xAI 登录提交后的跳转或 Turnstile",
    signal: ctx.signal
  });
}

async function handlePostLoginTurnstile(ctx, attempt) {
  const detection = await detectTurnstile(ctx);
  logger.info("xAI 登录提交后检测到 Cloudflare Turnstile", {
    attempt,
    maxAttempts: LOGIN_SUBMIT_MAX_ATTEMPTS,
    detection
  });
  const turnstileResult = await waitForTurnstileIfPresent(ctx);
  if (!turnstileResult.ok) {
    return {
      ok: false,
      status: "xai_sign_in_turnstile_timeout",
      error: turnstileResult.error || "等待 xAI 登录 Turnstile 完成超时",
      data: {
        turnstile: turnstileResult
      }
    };
  }
  logger.info("xAI 登录 Turnstile 已完成，准备重新点击登录", {
    attempt,
    matched: turnstileResult.matched || "",
    value: turnstileResult.value || null
  });
  return {
    ok: true
  };
}

async function ensurePasswordInputValue(ctx, password) {
  const state = await getPasswordInputState(ctx);
  if (!state?.exists || state.valueLength > 0) {
    return state;
  }
  return ctx.tabs.fill("input[name='password']", password);
}

async function getPasswordInputState(ctx) {
  return ctx.tabs.execute(() => {
    const input = document.querySelector("input[name='password']");
    if (!input) {
      return {
        exists: false,
        valueLength: 0
      };
    }
    return {
      exists: true,
      valueLength: String(input.value || "").length,
      disabled: Boolean(input.disabled),
      readOnly: Boolean(input.readOnly)
    };
  });
}

function resolvePassword(ctx) {
  const account = ctx.state.account || {};
  const historyRecord = ctx.state.historyRecord || {};
  const configuredPassword = ctx.config.accountProfiles?.xai?.specifiedPassword || "";
  return String(account.password || historyRecord.password || configuredPassword || "").trim();
}

async function waitForSignInSubmitButton(ctx, label) {
  return waitForAnyCondition([
    {
      name: "submit_button",
      check: () => findSignInSubmitButton(ctx)
    }
  ], {
    timeoutMs: 15000,
    intervalMs: 300,
    label,
    signal: ctx.signal
  });
}

async function findSignInSubmitButton(ctx) {
  return ctx.tabs.execute(() => {
    const button = findBestSubmitButton();
    return button ? describeButton(button) : null;

    function findBestSubmitButton() {
      const direct = document.querySelector("button[data-testid='sign-in-submit']");
      if (direct && isClickable(direct)) {
        return direct;
      }
      const keywords = ["下一步", "登录", "继续", "next", "sign in", "log in", "continue"];
      return Array.from(document.querySelectorAll("button"))
        .map((item) => ({ item, score: scoreButton(item, keywords) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score)[0]?.item || null;
    }

    function scoreButton(element, keywords) {
      if (!isClickable(element)) {
        return 0;
      }
      const text = String(element.textContent || element.getAttribute("aria-label") || "").trim().toLowerCase();
      const attrs = [
        element.getAttribute("data-testid"),
        element.getAttribute("name"),
        element.getAttribute("type")
      ].filter(Boolean).join(" ").toLowerCase();
      let score = 0;
      if (attrs.includes("sign-in-submit")) {
        score += 100;
      }
      if ((element.getAttribute("type") || "").toLowerCase() === "submit") {
        score += 10;
      }
      if (keywords.some((keyword) => text.includes(keyword))) {
        score += 20;
      }
      return score;
    }

    function describeButton(element) {
      return {
        text: String(element.textContent || "").trim(),
        type: element.getAttribute("type") || "",
        testId: element.getAttribute("data-testid") || "",
        disabled: Boolean(element.disabled),
        ariaDisabled: element.getAttribute("aria-disabled") || ""
      };
    }

    function isClickable(element) {
      const style = window.getComputedStyle(element);
      return style.visibility !== "hidden"
        && style.display !== "none"
        && element.getClientRects().length > 0
        && !element.disabled
        && element.getAttribute("aria-disabled") !== "true";
    }
  });
}

async function clickSignInSubmitButton(ctx) {
  return ctx.tabs.execute(() => {
    const button = findBestSubmitButton();
    if (!button) {
      return { ok: false, button: null };
    }
    button.scrollIntoView({ block: "center", inline: "center" });
    button.click();
    return {
      ok: true,
      button: {
        text: String(button.textContent || "").trim(),
        type: button.getAttribute("type") || "",
        testId: button.getAttribute("data-testid") || ""
      }
    };

    function findBestSubmitButton() {
      const direct = document.querySelector("button[data-testid='sign-in-submit']");
      if (direct && isClickable(direct)) {
        return direct;
      }
      const keywords = ["下一步", "登录", "继续", "next", "sign in", "log in", "continue"];
      return Array.from(document.querySelectorAll("button"))
        .map((item) => ({ item, score: scoreButton(item, keywords) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score)[0]?.item || null;
    }

    function scoreButton(element, keywords) {
      if (!isClickable(element)) {
        return 0;
      }
      const text = String(element.textContent || element.getAttribute("aria-label") || "").trim().toLowerCase();
      const attrs = [
        element.getAttribute("data-testid"),
        element.getAttribute("name"),
        element.getAttribute("type")
      ].filter(Boolean).join(" ").toLowerCase();
      let score = 0;
      if (attrs.includes("sign-in-submit")) {
        score += 100;
      }
      if ((element.getAttribute("type") || "").toLowerCase() === "submit") {
        score += 10;
      }
      if (keywords.some((keyword) => text.includes(keyword))) {
        score += 20;
      }
      return score;
    }

    function isClickable(element) {
      const style = window.getComputedStyle(element);
      return style.visibility !== "hidden"
        && style.display !== "none"
        && element.getClientRects().length > 0
        && !element.disabled
        && element.getAttribute("aria-disabled") !== "true";
    }
  });
}

async function waitForTurnstileIfPresent(ctx) {
  const detection = await detectTurnstile(ctx);
  if (!detection?.present) {
    return {
      ok: true,
      present: false,
      completed: false,
      reason: "not_present"
    };
  }

  logger.info("xAI 登录检测到 Cloudflare Turnstile，等待验证完成", {
    selectors: detection.selectors,
    hasResponseInput: detection.hasResponseInput,
    tokenLength: detection.tokenLength
  });

  const completed = await waitForAnyCondition(buildTurnstileCompletionConditions(ctx, detection), {
    timeoutMs: TURNSTILE_WAIT_TIMEOUT_MS,
    intervalMs: 800,
    label: "xAI 登录 Cloudflare Turnstile 验证完成",
    signal: ctx.signal
  });
  if (!completed.matched) {
    const latest = await detectTurnstile(ctx);
    logger.warn("等待 xAI 登录 Turnstile 完成超时", { latest });
    return {
      ok: false,
      present: true,
      completed: false,
      error: "Cloudflare Turnstile 未在限定时间内完成",
      latest
    };
  }

  return {
    ok: true,
    present: true,
    completed: true,
    matched: completed.name,
    value: completed.value
  };
}

function buildTurnstileCompletionConditions(ctx, detection) {
  if (detection.hasResponseInput) {
    return [
      {
        name: "turnstile_token",
        check: () => detectCompletedTurnstile(ctx)
      }
    ];
  }
  return [
    {
      name: "submit_ready_after_turnstile",
      check: () => findSignInSubmitButton(ctx)
    }
  ];
}

async function detectTurnstile(ctx) {
  return ctx.tabs.execute(() => {
    const responseInput = document.querySelector("input[name='cf-turnstile-response']");
    const selectors = [];
    if (responseInput) {
      selectors.push("input[name='cf-turnstile-response']");
    }
    if (document.querySelector(".cf-turnstile")) {
      selectors.push(".cf-turnstile");
    }
    if (document.querySelector("[data-sitekey]")) {
      selectors.push("[data-sitekey]");
    }
    if (document.querySelector("iframe[src*='challenges.cloudflare.com']")) {
      selectors.push("iframe[src*='challenges.cloudflare.com']");
    }
    const token = String(responseInput?.value || "").trim();
    return selectors.length > 0
      ? {
        present: true,
        selectors,
        hasResponseInput: Boolean(responseInput),
        tokenLength: token.length,
        completed: token.length > 0
      }
      : null;
  });
}

async function detectCompletedTurnstile(ctx) {
  return ctx.tabs.execute(() => {
    const responseInput = document.querySelector("input[name='cf-turnstile-response']");
    const token = String(responseInput?.value || "").trim();
    if (!token) {
      return null;
    }
    return {
      tokenLength: token.length
    };
  });
}

async function getXAiAccountUrl(ctx) {
  const currentUrl = await ctx.tabs.getCurrentUrl();
  return isXAiAccountUrl(currentUrl) ? currentUrl : null;
}

function isXAiAccountUrl(value) {
  try {
    const url = new URL(value || "");
    return url.hostname.endsWith("x.ai") && url.pathname === "/account";
  } catch {
    return false;
  }
}
