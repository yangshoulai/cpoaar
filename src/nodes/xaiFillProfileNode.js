import { RegisterNode, NodeResult } from "../core/flow.js";
import { waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";
import { clickVisibleButtonByText } from "./xaiHelpers.js";

const logger = createLogger("node.xai-profile");
const TURNSTILE_WAIT_TIMEOUT_MS = 120000;

export class XAiFillProfileNode extends RegisterNode {
  static name = "xai_fill_profile";
  static statuses = {
    success: "xai_profile_submitted"
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
    return NodeResult.ok(XAiFillProfileNode.statuses.success, {
      currentUrl: await ctx.tabs.getCurrentUrl()
    });
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
