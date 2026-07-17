import { RegisterNode, NodeResult } from "../core/flow.js";
import { waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";
import { clickVisibleButtonByText, findVisibleButtonByText } from "./xaiHelpers.js";

const logger = createLogger("node.xai-account");
const EXISTING_EMAIL_SIGN_IN_BUTTON_KEYWORDS = [
  "使用邮箱登录",
  "sign in with email",
  "log in with email",
  "continue with email"
];
const SIGN_IN_NAVIGATION_TIMEOUT_MS = 15000;

export class XAiWaitRegistrationCompleteNode extends RegisterNode {
  static name = "xai_wait_registration_complete";
  static statuses = {
    success: "xai_registration_completed",
    signInReady: "xai_existing_email_sign_in_ready"
  };

  constructor() {
    super(XAiWaitRegistrationCompleteNode.name, "xAI账号管理页面");
  }

  async execute(ctx) {
    const result = await waitForAnyCondition([
      {
        name: "account_page",
        check: async () => {
          const currentUrl = await ctx.tabs.getCurrentUrl();
          return isXAiAccountPage(currentUrl) ? currentUrl : null;
        }
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
      timeoutMs: 60000,
      label: "xAI 账号管理页或登录入口",
      signal: ctx.signal
    });
    if (!result.matched) {
      return NodeResult.fail("xai_registration_complete_timeout", `等待 xAI /account 页面超时: ${await ctx.tabs.getCurrentUrl()}`);
    }
    if (result.name === "sign_in_email_input") {
      return NodeResult.ok(XAiWaitRegistrationCompleteNode.statuses.signInReady, {
        currentUrl: await ctx.tabs.getCurrentUrl(),
        existingEmail: true
      });
    }
    if (result.name === "existing_email_sign_in_button") {
      const signInResult = await clickExistingEmailSignInButton(ctx);
      if (!signInResult.ok) {
        return NodeResult.fail(signInResult.status, signInResult.error, signInResult.data || {});
      }
      return NodeResult.ok(XAiWaitRegistrationCompleteNode.statuses.signInReady, {
        currentUrl: signInResult.currentUrl || await ctx.tabs.getCurrentUrl(),
        existingEmail: true
      });
    }
    return NodeResult.ok(XAiWaitRegistrationCompleteNode.statuses.success, {
      currentUrl: result.value
    });
  }
}

async function clickExistingEmailSignInButton(ctx) {
  const clickResult = await clickVisibleButtonByText(ctx, EXISTING_EMAIL_SIGN_IN_BUTTON_KEYWORDS);
  if (!clickResult.ok) {
    return {
      ok: false,
      status: "xai_existing_email_sign_in_failed",
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
    ok: true,
    currentUrl: signInReady.value || await ctx.tabs.getCurrentUrl()
  };
}

async function getXAiSignInUrl(ctx) {
  const currentUrl = await ctx.tabs.getCurrentUrl();
  return isXAiSignInPage(currentUrl) ? currentUrl : null;
}

function isXAiAccountPage(value) {
  try {
    const url = new URL(value);
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
