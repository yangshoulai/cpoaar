import { RegisterNode, NodeResult } from "../core/flow.js";
import { waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";
import { ReauthorizeDeleteAccountNode } from "./reauthorizeDeleteAccountNode.js";
import {
  findAccountDeactivatedMessage,
  promptRequired,
  resolvePhoneInputSelector,
  resolveVerificationCodeInputSelector
} from "./reauthorizeHelpers.js";

const logger = createLogger("node.reauth-phone");

export class ReauthorizePhoneChallengeNode extends RegisterNode {
  static name = "reauthorize_phone_challenge";
  static statuses = {
    consent: "reauthorize_phone_consent_ready",
    accountDeleted: "reauthorize_account_deactivated_ready",
    deleteAccount: ReauthorizeDeleteAccountNode.statuses.ready
  };

  constructor() {
    super(ReauthorizePhoneChallengeNode.name, "重新授权手机号二验");
  }

  async execute(ctx) {
    const action = ctx.config.reauthorize?.phoneChallengeAction || "stop";
    if (action === "delete_account") {
      return this._requestDeleteAccount(ctx, "重新授权出现手机号二验");
    }
    if (action === "stop") {
      return NodeResult.fail("reauthorize_phone_challenge_stopped", "重新授权出现手机号二验，配置为终止流程");
    }
    if (action !== "manual_code") {
      return NodeResult.fail("reauthorize_phone_challenge_failed", `不支持的手机号二验处理方式: ${action}`);
    }

    const phoneReady = await ensurePhoneSubmitted(ctx);
    if (!phoneReady.success) {
      return phoneReady;
    }
    if (phoneReady.status === ReauthorizePhoneChallengeNode.statuses.consent) {
      return phoneReady;
    }
    if (phoneReady.status === ReauthorizePhoneChallengeNode.statuses.accountDeleted) {
      return phoneReady;
    }

    const code = promptRequired("请输入手机号二验验证码");
    if (!code) {
      return NodeResult.fail("reauthorize_phone_code_empty", "未输入手机号二验验证码");
    }
    const inputSelector = await resolveVerificationCodeInputSelector(ctx);
    if (!inputSelector) {
      return NodeResult.fail("reauthorize_phone_code_input_missing", "未找到手机号二验验证码输入框");
    }
    await ctx.tabs.fill(inputSelector, code);
    await ctx.tabs.click("button[type='submit']");

    const result = await waitForAnyCondition([
      {
        name: "account_deactivated",
        check: () => findAccountDeactivatedMessage(ctx)
      },
      {
        name: "submit_error",
        check: () => ctx.tabs.queryText("ul[class^='_errors_']")
      },
      {
        name: "consent",
        check: () => ctx.tabs.urlContains("/sign-in-with-chatgpt/codex/consent")
      }
    ], {
      timeoutMs: 30000,
      label: "手动提交手机号二验后的页面结果"
    });

    const data = {
      manualPhoneVerificationCode: code,
      currentUrl: await ctx.tabs.getCurrentUrl()
    };
    if (!result.matched) {
      return NodeResult.fail("reauthorize_phone_code_failed", `提交手机号二验后未进入预期页面: ${data.currentUrl}`, data);
    }
    if (result.name === "account_deactivated") {
      return NodeResult.ok(ReauthorizePhoneChallengeNode.statuses.accountDeleted, data);
    }
    if (result.name === "submit_error") {
      return NodeResult.fail("reauthorize_phone_code_failed", String(result.value), data);
    }
    return NodeResult.ok(ReauthorizePhoneChallengeNode.statuses.consent, data);
  }

  async _requestDeleteAccount(ctx, reason) {
    const record = ctx.state.historyRecord;
    if (!record) {
      return NodeResult.fail("reauthorize_account_delete_failed", "上下文缺少账号记录，无法删除账号");
    }
    logger.warn("重新授权手机号二验，按配置删除账号", {
      email: record.emailAddress
    });
    return NodeResult.ok(ReauthorizePhoneChallengeNode.statuses.deleteAccount, {
      reauthorizeDeleteReason: reason
    });
  }
}

async function ensurePhoneSubmitted(ctx) {
  const existingCodeInput = await resolveVerificationCodeInputSelector(ctx);
  if (existingCodeInput) {
    return NodeResult.ok("phone_code_input_ready");
  }

  const phoneInputSelector = await resolvePhoneInputSelector(ctx);
  if (!phoneInputSelector) {
    return NodeResult.fail("reauthorize_phone_input_missing", "未找到手机号输入框");
  }
  let mobile = ctx.state.account?.mobile || ctx.state.historyRecord?.mobile || "";
  mobile = String(mobile || "").replace(/^\+/, "");
  if (!mobile) {
    mobile = promptRequired("请输入账号绑定手机号");
  }
  if (!mobile) {
    return NodeResult.fail("reauthorize_phone_empty", "未输入账号绑定手机号");
  }

  const fullMobile = mobile.startsWith("+") ? mobile : `+${mobile}`;
  await ctx.tabs.fill(phoneInputSelector, fullMobile);
  await ctx.tabs.click("button[type='submit']");

  const result = await waitForAnyCondition([
    {
      name: "code_input",
      check: () => resolveVerificationCodeInputSelector(ctx)
    },
    {
      name: "submit_error",
      check: () => ctx.tabs.queryText("ul[class^='_errors_']")
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
    label: "提交手机号后的二验页面"
  });

  if (!result.matched) {
    return NodeResult.fail("reauthorize_phone_submit_failed", `提交手机号后未进入验证码页面: ${await ctx.tabs.getCurrentUrl()}`);
  }
  if (result.name === "submit_error") {
    return NodeResult.fail("reauthorize_phone_submit_failed", String(result.value));
  }
  if (result.name === "account_deactivated") {
    return NodeResult.ok(ReauthorizePhoneChallengeNode.statuses.accountDeleted);
  }
  if (result.name === "consent") {
    return NodeResult.ok(ReauthorizePhoneChallengeNode.statuses.consent);
  }
  return NodeResult.ok("phone_code_input_ready");
}
