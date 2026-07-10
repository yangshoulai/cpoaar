import { RegisterNode, NodeResult } from "../core/flow.js";
import { waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";
import { appendRegisterHistory } from "../core/storage.js";
import { ACCOUNT_TYPES, RUN_MODES } from "../core/runModes.js";
import {
  buildXAiRedirectUrl,
  clickVisibleButtonByText,
  findVisibleButtonByText,
  getReadonlyAuthorizationCode
} from "./xaiHelpers.js";

const logger = createLogger("node.xai-consent");

export class XAiSubmitConsentNode extends RegisterNode {
  static name = "xai_submit_consent";
  static statuses = {
    success: "xai_account_exported"
  };

  constructor() {
    super(XAiSubmitConsentNode.name, "xAI 账号导出");
  }

  async execute(ctx) {
    const consentReady = await waitForAnyCondition([
      {
        name: "consent_url",
        check: () => ctx.tabs.urlContains("/oauth2/consent")
      },
      {
        name: "allow_button",
        check: () => findVisibleButtonByText(ctx, ["允许", "allow", "authorize"])
      }
    ], {
      timeoutMs: 30000,
      label: "xAI OAuth consent 授权按钮",
      signal: ctx.signal
    });
    if (!consentReady.matched) {
      return NodeResult.fail("xai_oauth_consent_missing", `未找到 xAI OAuth consent 页面或允许按钮: ${await ctx.tabs.getCurrentUrl()}`);
    }

    const allowButtonReady = await waitForAnyCondition([
      {
        name: "allow_button",
        check: () => findVisibleButtonByText(ctx, ["允许", "allow", "authorize"])
      }
    ], {
      timeoutMs: 30000,
      label: "xAI OAuth 允许按钮",
      signal: ctx.signal
    });
    if (!allowButtonReady.matched) {
      return NodeResult.fail("xai_oauth_consent_missing", `未找到 xAI OAuth 允许按钮: ${await ctx.tabs.getCurrentUrl()}`);
    }

    const clickResult = await clickVisibleButtonByText(ctx, ["允许", "allow", "authorize"]);
    if (!clickResult.ok) {
      return NodeResult.fail("xai_oauth_allow_failed", "未能点击 xAI OAuth 允许按钮");
    }

    const codeResult = await waitForAnyCondition([
      {
        name: "authorization_code",
        check: () => getReadonlyAuthorizationCode(ctx)
      }
    ], {
      timeoutMs: 30000,
      label: "xAI OAuth 授权码",
      signal: ctx.signal
    });
    if (!codeResult.matched || !codeResult.value) {
      return NodeResult.fail("xai_oauth_code_missing", `点击允许后未获取到 xAI 授权码: ${await ctx.tabs.getCurrentUrl()}`);
    }

    const authorizationCode = String(codeResult.value || "").trim();
    const oauthState = resolveOauthState(ctx.state.xaiOauthUrl);
    if (!oauthState) {
      return NodeResult.fail("xai_oauth_state_missing", "xAI OAuth 链接缺少 state 参数，无法提交回调地址", {
        xaiOauthUrl: ctx.state.xaiOauthUrl || null,
        xaiAuthorizationCode: authorizationCode
      });
    }
    const redirectUrl = buildXAiRedirectUrl(authorizationCode, oauthState);
    const submitResult = await ctx.services.accountManagementService.submitRedirectUrl(redirectUrl, {
      accountType: ACCOUNT_TYPES.xai
    });
    if (!submitResult.success) {
      return NodeResult.fail("xai_account_export_failed", submitResult.error || `xAI 账号导出失败: ${submitResult.status}`, {
        xaiOauthRedirectUrl: redirectUrl,
        xaiAuthorizationCode: authorizationCode,
        accountExportSubmitResult: submitResult
      });
    }

    await ctx.services.emailService.callback(ctx.state.emailAccount, true);
    await appendRegisterHistory({
      accountType: ACCOUNT_TYPES.xai,
      flowMode: RUN_MODES.xaiRegister,
      emailAddress: ctx.state.account?.emailAddress || "",
      mobile: "",
      smsProvider: "",
      activationId: "",
      name: ctx.state.account?.name || "",
      firstName: ctx.state.account?.firstName || "",
      lastName: ctx.state.account?.lastName || "",
      age: ctx.state.account?.age || "",
      birthDate: ctx.state.account?.birthDate?.value || "",
      password: ctx.state.account?.password || "",
      emailProvider: "outlook_mail",
      emailMode: resolveEmailMode(ctx.state.emailAccount),
      emailAccount: ctx.state.emailAccount || null,
      outlookAccountId: ctx.state.emailAccount?.attributes?.accountId || "",
      emailVerificationCode: ctx.state.account?.emailVerificationCode || "",
      smsVerificationCode: "",
      xaiAuthorizationCode: authorizationCode,
      xaiOauthState: oauthState,
      xaiOauthRedirectUrl: redirectUrl,
      accountExportStatus: submitResult.status,
      accountExportResult: submitResult.attributes || {}
    });

    logger.info("xAI 账号导出完成", {
      email: ctx.state.account?.emailAddress,
      password: ctx.state.account?.password,
      name: ctx.state.account?.name,
      emailVerificationCode: ctx.state.account?.emailVerificationCode
    });
    return NodeResult.ok(XAiSubmitConsentNode.statuses.success, {
      xaiAuthorizationCode: authorizationCode,
      xaiOauthState: oauthState,
      xaiOauthRedirectUrl: redirectUrl,
      accountExportSubmitResult: submitResult
    });
  }
}

function resolveOauthState(oauth = {}) {
  if (oauth.state) {
    return String(oauth.state).trim();
  }
  try {
    return new URL(oauth.url || "").searchParams.get("state") || "";
  } catch {
    return "";
  }
}

function resolveEmailMode(emailAccount) {
  if (emailAccount?.attributes?.mode === "temp") {
    return "temp";
  }
  return "outlook_pool";
}
