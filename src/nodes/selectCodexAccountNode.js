import { RegisterNode, NodeResult } from "../core/flow.js";
import { waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";
import { isOpenAiReauthorizeMode } from "../core/runModes.js";
import {
  clickOneTimeCodeLoginButton,
  findAccountDeactivatedMessage,
  findOneTimeCodeLoginButton,
  hasPhoneChallenge
} from "./reauthorizeHelpers.js";

const logger = createLogger("node.select-codex");

export class SelectCodexAccountNode extends RegisterNode {
  static name = "select_codex_account";
  static statuses = {
    emailVerificationReady: "codex_oauth_email_verification_ready",
    needsPhone: "codex_oauth_needs_phone",
    consent: "codex_oauth_consent_ready",
    accountDeleted: "reauthorize_account_deactivated_ready"
  };

  constructor() {
    super(SelectCodexAccountNode.name, "刷新 OAuth 并登录");
  }

  async execute(ctx) {
    const account = ctx.state.account;
    if (!account?.emailAddress) {
      return NodeResult.fail("codex_oauth_account_select_failed", "上下文缺少账号邮箱");
    }

    let oauth;
    try {
      oauth = await ctx.services.accountManagementService.getOauthUrl();
    } catch (error) {
      return NodeResult.fail("codex_oauth_request_failed", formatServiceError(error));
    }
    ctx.state.codexOauthUrl = oauth;
    await ctx.tabs.navigate(oauth.url);

    const accountResult = await waitForAnyCondition([
      {
        name: "account_button",
        check: () => ctx.tabs.findAccountButton(account.emailAddress)
      },
      {
        name: "email_input",
        check: () => ctx.tabs.query("input[name='email']")
      },
      {
        name: "one_time_code_login",
        check: () => findOneTimeCodeLoginButton(ctx)
      },
      {
        name: "needs_phone",
        check: async () => await hasPhoneChallenge(ctx) ? "phone_challenge" : null
      },
      {
        name: "account_deactivated",
        check: () => findAccountDeactivatedMessage(ctx)
      },
      {
        name: "consent",
        check: () => ctx.tabs.urlContains("/sign-in-with-chatgpt/codex/consent")
      }
    ], {
      timeoutMs: 30000,
      label: "Codex OAuth 账号选择页"
    });

    if (!accountResult.matched) {
      return NodeResult.fail("codex_oauth_unexpected_url", `未找到账号选择按钮或邮箱输入框: ${await ctx.tabs.getCurrentUrl()}`);
    }
    if (accountResult.name === "needs_phone") {
      return NodeResult.ok(SelectCodexAccountNode.statuses.needsPhone, { currentUrl: await ctx.tabs.getCurrentUrl() });
    }
    if (accountResult.name === "account_deactivated") {
      return buildAccountDeactivatedResult(ctx, { currentUrl: await ctx.tabs.getCurrentUrl() });
    }
    if (accountResult.name === "consent") {
      return NodeResult.ok(SelectCodexAccountNode.statuses.consent, { currentUrl: await ctx.tabs.getCurrentUrl() });
    }
    if (accountResult.name === "email_input") {
      logger.info("OAuth 页面要求重新登录，填写邮箱");
      await ctx.tabs.fill("input[name='email']", account.emailAddress);
      ctx.state.emailSubmittedAt = new Date().toISOString();
      await ctx.tabs.click("button[type='submit']");
      return NodeResult.ok(SelectCodexAccountNode.statuses.emailVerificationReady, {
        emailSubmittedAt: ctx.state.emailSubmittedAt,
        currentUrl: await ctx.tabs.getCurrentUrl()
      });
    }
    if (accountResult.name === "one_time_code_login") {
      return switchToOneTimeCodeLogin(ctx);
    }

    logger.info("点击 Codex OAuth 账号按钮", { email: account.emailAddress });
    await ctx.tabs.clickAccountButton(account.emailAddress);
    const nextResult = await waitForAnyCondition([
      {
        name: "email_verification_ready",
        check: () => ctx.tabs.query("input[name='code']")
      },
      {
        name: "one_time_code_login",
        check: () => findOneTimeCodeLoginButton(ctx)
      },
      {
        name: "needs_phone",
        check: async () => await hasPhoneChallenge(ctx) ? "phone_challenge" : null
      },
      {
        name: "account_deactivated",
        check: () => findAccountDeactivatedMessage(ctx)
      },
      {
        name: "consent",
        check: () => ctx.tabs.urlContains("/sign-in-with-chatgpt/codex/consent")
      }
    ], {
      timeoutMs: 30000,
      label: "刷新 OAuth 并登录后的页面"
    });

    const currentUrl = await ctx.tabs.getCurrentUrl();
    if (!nextResult.matched) {
      return NodeResult.fail("codex_oauth_unexpected_url", `选择账号后未进入邮箱验证码、手机号或 consent 页面: ${currentUrl}`, { currentUrl });
    }
    if (nextResult.name === "email_verification_ready") {
      return NodeResult.ok(SelectCodexAccountNode.statuses.emailVerificationReady, { currentUrl });
    }
    if (nextResult.name === "one_time_code_login") {
      return switchToOneTimeCodeLogin(ctx);
    }
    if (nextResult.name === "account_deactivated") {
      return buildAccountDeactivatedResult(ctx, { currentUrl });
    }
    return NodeResult.ok(
      nextResult.name === "needs_phone"
        ? SelectCodexAccountNode.statuses.needsPhone
        : SelectCodexAccountNode.statuses.consent,
      { currentUrl }
    );
  }
}

async function switchToOneTimeCodeLogin(ctx) {
  const clicked = await clickOneTimeCodeLoginButton(ctx);
  const currentUrl = await ctx.tabs.getCurrentUrl();
  if (!clicked) {
    return NodeResult.fail("codex_oauth_unexpected_url", `未能点击一次性验证码登录按钮: ${currentUrl}`, { currentUrl });
  }
  ctx.state.emailSubmittedAt = new Date().toISOString();
  logger.info("OAuth 密码页切换为一次性验证码登录", {
    currentUrl
  });
  return NodeResult.ok(SelectCodexAccountNode.statuses.emailVerificationReady, {
    emailSubmittedAt: ctx.state.emailSubmittedAt,
    currentUrl
  });
}

function formatServiceError(error) {
  const message = `${error.name}: ${error.message}`;
  if (error.url) {
    return `${message}；URL=${error.url}`;
  }
  return message;
}

function buildAccountDeactivatedResult(ctx, data = {}) {
  if (isOpenAiReauthorizeMode(ctx.config.register?.mode)) {
    return NodeResult.ok(SelectCodexAccountNode.statuses.accountDeleted, data);
  }
  return NodeResult.fail("codex_oauth_account_deactivated", "账号已停用: account_deactivated", data);
}
