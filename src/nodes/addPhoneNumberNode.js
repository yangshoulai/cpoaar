import { RegisterNode, NodeResult } from "../core/flow.js";
import { waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("node.add-phone");

const RETRYABLE_PHONE_ERRORS = [
  "电话号码已被使用",
  "电话号码无效",
  "请继续通过 WhatsApp 发送验证码",
  "此电话号码已关联到可关联的最多账户"
];

export class AddPhoneNumberNode extends RegisterNode {
  static name = "add_phone_number";
  static statuses = {
    success: "phone_submitted",
    oauthReauthRequired: "phone_waited_oauth_reauth_required"
  };

  constructor() {
    super(AddPhoneNumberNode.name, "手机号验证");
  }

  async execute(ctx) {
    if (!ctx.services.smsService) {
      return NodeResult.fail("sms_service_not_configured", "未配置短信服务");
    }

    const maxAttempts = Number(ctx.config.register.phoneNumberRetryAttempts || 1);
    let retryCount = 0;
    while (true) {
      const result = await this._submitOneMobile(ctx);
      if (
        result.status === "phone_submit_error"
        && result.error
        && RETRYABLE_PHONE_ERRORS.some((text) => result.error.includes(text))
        && retryCount < maxAttempts
      ) {
        retryCount += 1;
        logger.warn("手机号不可用，重新获取手机号重试", {
          error: result.error,
          retryCount,
          maxAttempts
        });
        continue;
      }
      return result;
    }
  }

  async _submitOneMobile(ctx) {
    const account = ctx.state.account;
    const excluded = ctx.state.triedSmsActivationIds || [];
    let mobileNumber = takePendingMobile(ctx);

    if (!mobileNumber) {
      mobileNumber = await ctx.services.smsService.getMobileNumber({
        excludedActivationIds: excluded,
        signal: ctx.signal
      });
      if (!mobileNumber) {
        return NodeResult.fail("stopped", "流程已停止");
      }
      const waitSeconds = Number(mobileNumber.attributes?.reusableActivationWaitSeconds || 0);
      const threshold = Number(ctx.config.register.oauthReauthWaitThresholdSeconds || 60);
      if (waitSeconds > threshold) {
        ctx.state.smsMobileNumber = mobileNumber;
        ctx.state.smsMobileOauthReauthPending = true;
        return NodeResult.ok(AddPhoneNumberNode.statuses.oauthReauthRequired, {
          smsMobileNumber: mobileNumber,
          smsReusableActivationWaitSeconds: waitSeconds,
          currentUrl: await ctx.tabs.getCurrentUrl()
        });
      }
    }

    rememberTriedActivation(ctx, mobileNumber);
    account.mobile = normalizeMobile(mobileNumber.mobileNumber);
    ctx.state.smsMobileNumber = mobileNumber;
    logger.info("填写手机号", {
      mobile: account.mobile,
      provider: mobileNumber.attributes?.provider || ""
    });

    const phoneInputSelector = await resolvePhoneInputSelector(ctx);
    const fullMobileNumber = `+${account.mobile}`;
    const fillResult = await ctx.tabs.fill(phoneInputSelector, fullMobileNumber);
    if (!fillResult.ok) {
      return NodeResult.fail("phone_submit_failed", "未找到手机号输入框");
    }

    await selectSmsMethodIfPresent(ctx);
    const phoneSubmittedAt = new Date().toISOString();
    ctx.state.phoneSubmittedAt = phoneSubmittedAt;
    await ctx.tabs.click("button[type='submit']");

    const waitResult = await waitForAnyCondition([
      {
        name: "submit_error",
        check: () => ctx.tabs.queryText("ul[class^='_errors_']")
      },
      {
        name: "phone_verification",
        check: () => ctx.tabs.urlContains("/phone-verification")
      }
    ], {
      timeoutMs: 30000,
      label: "手机号提交后的页面结果"
    });

    const currentUrl = await ctx.tabs.getCurrentUrl();
    const data = {
      smsMobileNumber: mobileNumber,
      phoneSubmittedAt,
      currentUrl
    };

    if (!waitResult.matched) {
      await ctx.services.smsService.callback(mobileNumber, false);
      return NodeResult.fail("phone_verification_unexpected_url", `提交手机号后未进入验证码页面: ${currentUrl}`, data);
    }
    if (waitResult.name === "submit_error") {
      await ctx.services.smsService.callback(mobileNumber, false);
      return NodeResult.fail("phone_submit_error", String(waitResult.value), data);
    }
    return NodeResult.ok(AddPhoneNumberNode.statuses.success, data);
  }
}

async function resolvePhoneInputSelector(ctx) {
  if (await ctx.tabs.query("input[id='tel']")) {
    return "input[id='tel']";
  }
  if (await ctx.tabs.query("input[id='input']")) {
    return "input[id='input']";
  }
  return "input[type='tel']";
}

async function selectSmsMethodIfPresent(ctx) {
  const smsState = await ctx.tabs.getLabelStateForInputValue("sms");
  if (smsState === null) {
    logger.info("页面没有短信/WhatsApp 选择项，按默认 SMS 继续");
    return;
  }
  if (smsState === "on") {
    logger.info("短信验证方式已经选中");
    return;
  }
  logger.info("切换验证码接收方式为 SMS");
  await ctx.tabs.clickLabelForInputValue("whatsapp");
  await ctx.tabs.clickLabelForInputValue("sms");
}

function takePendingMobile(ctx) {
  if (!ctx.state.smsMobileOauthReauthPending || !ctx.state.smsMobileNumber) {
    return null;
  }
  const mobileNumber = ctx.state.smsMobileNumber;
  ctx.state.smsMobileOauthReauthPending = false;
  logger.info("OAuth 重新认证完成，继续使用等待后的历史手机号", {
    mobile: mobileNumber.mobileNumber
  });
  return mobileNumber;
}

function rememberTriedActivation(ctx, mobileNumber) {
  const activationId = mobileNumber.attributes?.activationId;
  if (!activationId) {
    return;
  }
  const current = new Set(ctx.state.triedSmsActivationIds || []);
  current.add(String(activationId));
  ctx.state.triedSmsActivationIds = [...current];
}

function normalizeMobile(mobile) {
  return String(mobile || "").trim().replace(/^\+/, "");
}
