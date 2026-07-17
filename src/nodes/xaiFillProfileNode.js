import { RegisterNode, NodeResult } from "../core/flow.js";
import { waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";
import { clickVisibleButtonByText, findVisibleButtonByText } from "./xaiHelpers.js";

const logger = createLogger("node.xai-profile");
const TURNSTILE_WAIT_TIMEOUT_MS = 120000;
const EXISTING_EMAIL_SIGN_IN_BUTTON_KEYWORDS = [
  "使用邮箱登录",
  "sign in with email",
  "log in with email",
  "continue with email"
];
const PROFILE_SUBMIT_OUTCOME_TIMEOUT_MS = 10000;
const SIGN_IN_NAVIGATION_TIMEOUT_MS = 15000;

export class XAiFillProfileNode extends RegisterNode {
  static name = "xai_fill_profile";
  static statuses = {
    success: "xai_profile_submitted",
    signInReady: "xai_existing_email_sign_in_ready"
  };

  constructor() {
    super(XAiFillProfileNode.name, "xAI 资料填写");
  }

  async execute(ctx) {
    const account = ctx.state.account;
    if (!account) {
      return NodeResult.fail("xai_profile_failed", "上下文缺少 xAI 账号信息");
    }

    const readyResult = await waitForAnyCondition([
      {
        name: "profile_form",
        check: () => ctx.tabs.query("input[name='givenName']")
      }
    ], {
      timeoutMs: 30000,
      label: "xAI 资料填写表单",
      signal: ctx.signal
    });
    if (!readyResult.matched) {
      return NodeResult.fail("xai_profile_form_missing", `未找到 xAI 资料填写表单: ${await ctx.tabs.getCurrentUrl()}`);
    }

    logger.info("填写 xAI 资料", {
      email: account.emailAddress,
      givenName: account.firstName,
      familyName: account.lastName
    });
    const givenNameResult = await ctx.tabs.fill("input[name='givenName']", account.firstName || account.name || "");
    if (!givenNameResult.ok) {
      return NodeResult.fail("xai_profile_failed", "未找到 givenName 输入框");
    }
    const familyNameResult = await ctx.tabs.fill("input[name='familyName']", account.lastName || account.name || "");
    if (!familyNameResult.ok) {
      return NodeResult.fail("xai_profile_failed", "未找到 familyName 输入框");
    }
    const passwordResult = await ctx.tabs.fill("input[name='password']", account.password || "");
    if (!passwordResult.ok) {
      return NodeResult.fail("xai_profile_failed", "未找到 password 输入框");
    }

    const turnstileResult = await waitForTurnstileIfPresent(ctx);
    if (!turnstileResult.ok) {
      return NodeResult.fail("xai_turnstile_timeout", turnstileResult.error || "等待 Cloudflare Turnstile 完成超时", {
        turnstile: turnstileResult
      });
    }

    const submitReady = await waitForAnyCondition([
      {
        name: "submit_ready",
        check: () => findCompleteRegistrationButton(ctx)
      }
    ], {
      timeoutMs: 10000,
      intervalMs: 300,
      label: "xAI 完成注册按钮",
      signal: ctx.signal
    });
    if (!submitReady.matched) {
      return NodeResult.fail("xai_profile_submit_failed", "xAI 完成注册按钮不可用");
    }

    const submitResult = await clickVisibleButtonByText(ctx, ["完成注册", "complete registration", "sign up", "注册"]);
    if (!submitResult.ok) {
      return NodeResult.fail("xai_profile_submit_failed", "xAI 完成注册按钮点击失败");
    }
    logger.info("xAI 资料已提交", {
      submitButton: submitResult.button?.text || ""
    });

    const outcome = await waitForProfileSubmitOutcome(ctx);
    if (outcome.status === "sign_in_ready") {
      return NodeResult.ok(XAiFillProfileNode.statuses.signInReady, {
        account,
        currentUrl: outcome.currentUrl || await ctx.tabs.getCurrentUrl(),
        existingEmail: true
      });
    }
    if (outcome.status === "failed") {
      return NodeResult.fail(outcome.failStatus, outcome.error, outcome.data || {});
    }

    return NodeResult.ok(XAiFillProfileNode.statuses.success, {
      currentUrl: await ctx.tabs.getCurrentUrl()
    });
  }
}

async function waitForProfileSubmitOutcome(ctx) {
  const result = await waitForAnyCondition([
    {
      name: "account_page",
      check: () => getXAiAccountPageUrl(ctx)
    },
    {
      name: "sign_in_email_input",
      check: () => ctx.tabs.findEmailInput()
    },
    {
      name: "existing_email_sign_in_button",
      check: () => findVisibleButtonByText(ctx, EXISTING_EMAIL_SIGN_IN_BUTTON_KEYWORDS)
    }
  ], {
    timeoutMs: PROFILE_SUBMIT_OUTCOME_TIMEOUT_MS,
    intervalMs: 500,
    label: "xAI 资料提交结果",
    signal: ctx.signal
  });

  if (!result.matched || result.name === "account_page") {
    return {
      status: "continue",
      currentUrl: result.value || ""
    };
  }
  if (result.name === "sign_in_email_input") {
    return {
      status: "sign_in_ready",
      currentUrl: await ctx.tabs.getCurrentUrl()
    };
  }

  const clickResult = await clickVisibleButtonByText(ctx, EXISTING_EMAIL_SIGN_IN_BUTTON_KEYWORDS);
  if (!clickResult.ok) {
    return {
      status: "failed",
      failStatus: "xai_existing_email_sign_in_failed",
      error: "邮箱已存在页面的使用邮箱登录按钮点击失败"
    };
  }

  const signInReady = await waitForAnyCondition([
    {
      name: "sign_in_url",
      check: () => getXAiSignInUrl(ctx)
    },
    {
      name: "sign_in_email_input",
      check: () => ctx.tabs.findEmailInput()
    }
  ], {
    timeoutMs: SIGN_IN_NAVIGATION_TIMEOUT_MS,
    intervalMs: 500,
    label: "xAI 已存在邮箱登录入口",
    signal: ctx.signal
  });

  if (!signInReady.matched) {
    logger.warn("点击使用邮箱登录后未检测到登录页，后续登录节点会重新打开登录页", {
      currentUrl: await ctx.tabs.getCurrentUrl()
    });
  }

  return {
    status: "sign_in_ready",
    currentUrl: signInReady.value || await ctx.tabs.getCurrentUrl()
  };
}

async function getXAiAccountPageUrl(ctx) {
  const currentUrl = await ctx.tabs.getCurrentUrl();
  return isXAiAccountPage(currentUrl) ? currentUrl : null;
}

async function getXAiSignInUrl(ctx) {
  const currentUrl = await ctx.tabs.getCurrentUrl();
  return isXAiSignInPage(currentUrl) ? currentUrl : null;
}

function isXAiAccountPage(value) {
  try {
    const url = new URL(value || "");
    return url.hostname === "accounts.x.ai" && url.pathname.startsWith("/account");
  } catch {
    return false;
  }
}

function isXAiSignInPage(value) {
  try {
    const url = new URL(value || "");
    return url.hostname === "accounts.x.ai" && url.pathname.startsWith("/sign-in");
  } catch {
    return false;
  }
}

async function findCompleteRegistrationButton(ctx) {
  return ctx.tabs.execute(() => {
    const keywords = ["完成注册", "complete registration", "sign up", "注册"];
    const button = Array.from(document.querySelectorAll("button"))
      .find((item) => {
        const text = String(item.textContent || "").trim().toLowerCase();
        return keywords.some((keyword) => text.includes(keyword.toLowerCase()))
          && isClickable(item);
      });
    return button ? {
      text: String(button.textContent || "").trim(),
      disabled: button.disabled
    } : null;

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
  if (!detection.present) {
    return {
      ok: true,
      present: false,
      completed: false,
      reason: "not_present"
    };
  }

  logger.info("检测到 Cloudflare Turnstile，等待验证完成", {
    selectors: detection.selectors,
    hasResponseInput: detection.hasResponseInput,
    tokenLength: detection.tokenLength
  });

  const completed = await waitForAnyCondition(buildTurnstileCompletionConditions(ctx, detection), {
    timeoutMs: TURNSTILE_WAIT_TIMEOUT_MS,
    intervalMs: 800,
    label: "Cloudflare Turnstile 验证完成",
    signal: ctx.signal
  });
  if (!completed.matched) {
    const latest = await detectTurnstile(ctx);
    logger.warn("等待 Cloudflare Turnstile 完成超时", {
      latest
    });
    return {
      ok: false,
      present: true,
      completed: false,
      error: "Cloudflare Turnstile 未在限定时间内完成",
      latest
    };
  }

  logger.info("Cloudflare Turnstile 已完成", {
    matched: completed.name,
    value: completed.value
  });
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
      check: () => findCompleteRegistrationButton(ctx)
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
    return {
      present: selectors.length > 0,
      selectors,
      hasResponseInput: Boolean(responseInput),
      tokenLength: token.length,
      completed: token.length > 0
    };
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
