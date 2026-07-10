import { RegisterNode, NodeResult } from "../core/flow.js";
import { waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";
import { appendRegisterHistory } from "../core/storage.js";
import { ACCOUNT_TYPES, RUN_MODES, isOpenAiRegisterMode } from "../core/runModes.js";

const logger = createLogger("node.consent");

export class SubmitCodexConsentNode extends RegisterNode {
  static name = "submit_codex_consent";
  static statuses = {
    success: "codex_account_exported"
  };

  constructor() {
    super(SubmitCodexConsentNode.name, "账号导出");
  }

  async execute(ctx) {
    const clicked = await clickSubmitButton(ctx);
    if (!clicked) {
      return NodeResult.fail("codex_consent_submit_failed", "未找到 Codex consent 提交按钮");
    }

    const redirectResult = await waitForAnyCondition([
      {
        name: "localhost_redirect",
        check: async () => {
          const url = await ctx.tabs.getCurrentUrl();
          return url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1")
            ? url
            : null;
        }
      }
    ], {
      timeoutMs: 30000,
      label: "等待 OAuth localhost 回调地址"
    });
    if (!redirectResult.matched) {
      return NodeResult.fail("codex_oauth_redirect_timeout", `提交 consent 后未跳转到 localhost: ${await ctx.tabs.getCurrentUrl()}`);
    }

    const redirectUrl = redirectResult.value;
    const submitResult = await ctx.services.accountManagementService.submitRedirectUrl(redirectUrl);
    if (!submitResult.success) {
      return NodeResult.fail("account_export_failed", submitResult.error || `账号导出失败: ${submitResult.status}`, {
        codexOauthRedirectUrl: redirectUrl,
        accountExportSubmitResult: submitResult
      });
    }

    await ctx.services.emailService.callback(ctx.state.emailAccount, true);
    if (isOpenAiRegisterMode(ctx.config.register?.mode)) {
      await appendRegisterHistory({
        accountType: ACCOUNT_TYPES.openai,
        flowMode: RUN_MODES.openaiRegister,
        emailAddress: ctx.state.account?.emailAddress || "",
        mobile: ctx.state.account?.mobile || "",
        smsProvider: ctx.state.smsMobileNumber?.attributes?.provider || "",
        activationId: ctx.state.smsMobileNumber?.attributes?.activationId || "",
        name: ctx.state.account?.name || "",
        age: ctx.state.account?.age || "",
        birthDate: ctx.state.account?.birthDate?.value || "",
        password: ctx.state.account?.password || "",
        emailProvider: "outlook_mail",
        emailMode: resolveEmailMode(ctx.state.emailAccount),
        emailAccount: ctx.state.emailAccount || null,
        outlookAccountId: ctx.state.emailAccount?.attributes?.accountId || "",
        emailVerificationCode: ctx.state.account?.emailVerificationCode || "",
        smsVerificationCode: ctx.state.account?.smsVerificationCode || "",
        codexOauthRedirectUrl: redirectUrl,
        accountExportStatus: submitResult.status,
        accountExportResult: submitResult.attributes || {}
      });
    }
    logger.info("账号导出完成", {
      email: ctx.state.account?.emailAddress,
      mobile: ctx.state.account?.mobile,
      password: ctx.state.account?.password,
      name: ctx.state.account?.name,
      age: ctx.state.account?.age,
      birthDate: ctx.state.account?.birthDate?.value,
      emailVerificationCode: ctx.state.account?.emailVerificationCode,
      smsVerificationCode: ctx.state.account?.smsVerificationCode
    });
    return NodeResult.ok(SubmitCodexConsentNode.statuses.success, {
      codexOauthRedirectUrl: redirectUrl,
      accountExportSubmitResult: submitResult
    });
  }
}

async function clickSubmitButton(ctx) {
  if (await ctx.tabs.query("button[type='submit']")) {
    await ctx.tabs.click("button[type='submit']");
    return true;
  }
  if (await ctx.tabs.query("button")) {
    await ctx.tabs.click("button");
    return true;
  }
  return false;
}

function resolveEmailMode(emailAccount) {
  if (emailAccount?.attributes?.mode === "temp") {
    return "temp";
  }
  return "outlook_pool";
}
