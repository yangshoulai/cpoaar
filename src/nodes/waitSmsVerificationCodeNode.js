import { RegisterNode, NodeResult, buildFlowStoppedResult, isFlowStopped } from "../core/flow.js";
import { waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("node.sms-code");
const DEFAULT_SMS_WAIT_TIMEOUT_SECONDS = 60;

export class WaitSmsVerificationCodeNode extends RegisterNode {
  static name = "wait_sms_verification_code";
  static statuses = {
    success: "phone_verified",
    aboutYouReady: "phone_verified_about_you_ready",
    retrySelectCodexAccount: "sms_verification_retry_select_codex_account"
  };

  constructor() {
    super(WaitSmsVerificationCodeNode.name, "短信验证码");
  }

  async execute(ctx) {
    const mobileNumber = ctx.state.smsMobileNumber;
    if (!mobileNumber) {
      return NodeResult.fail("phone_verification_failed", "上下文缺少短信手机号");
    }
    let resendAttempts = 0;

    while (true) {
      if (isFlowStopped(ctx)) {
        return buildFlowStoppedResult();
      }
      logger.info("等待短信验证码", {
        mobile: mobileNumber.mobileNumber,
        resendAttempts
      });
      const waitResult = await waitForSmsCodeOrWhatsApp(ctx, mobileNumber);
      if (isFlowStopped(ctx)) {
        return buildFlowStoppedResult();
      }
      if (waitResult.type === "whatsapp") {
        logger.warn("检测到验证码通过 WhatsApp 发送，短信服务无法接收", {
          mobile: mobileNumber.mobileNumber,
          button: waitResult.detail
        });
        await ctx.services.smsService.callback(mobileNumber, false);
        return buildRetryOrFail(
          ctx,
          "sms_verification_whatsapp_detected",
          "检测到验证码通过 WhatsApp 发送，短信服务无法接收",
          "",
          {
            whatsappResendButton: waitResult.detail || null
          }
        );
      }
      const code = waitResult.code || "";
      if (!code) {
        const whatsappResendButton = await detectWhatsAppResendButton(ctx);
        if (whatsappResendButton) {
          logger.warn("短信验证码超时后检测到 WhatsApp 重发按钮", {
            mobile: mobileNumber.mobileNumber,
            button: whatsappResendButton
          });
          await ctx.services.smsService.callback(mobileNumber, false);
          return buildRetryOrFail(
            ctx,
            "sms_verification_whatsapp_detected",
            "检测到验证码通过 WhatsApp 发送，短信服务无法接收",
            "",
            {
              whatsappResendButton
            }
          );
        }
        if (resendAttempts < 1) {
          const resent = await clickResend(ctx);
          if (resent) {
            resendAttempts += 1;
            ctx.state.phoneSubmittedAt = new Date().toISOString();
            continue;
          }
        }
        await ctx.services.smsService.callback(mobileNumber, false);
        return buildRetryOrFail(ctx, "sms_verification_code_timeout", "等待短信验证码超时", "");
      }

      ctx.state.account.smsVerificationCode = code;
      const submitResult = await submitSmsCode(ctx, code);
      if (submitResult.stopped || isFlowStopped(ctx)) {
        return buildFlowStoppedResult();
      }
      const currentUrl = await ctx.tabs.getCurrentUrl();
      if (submitResult.name === "about_you") {
        await ctx.services.smsService.callback(mobileNumber, true);
        return NodeResult.ok(WaitSmsVerificationCodeNode.statuses.aboutYouReady, {
          smsVerificationCode: code,
          currentUrl
        });
      }
      if (submitResult.name === "consent_ready") {
        await ctx.services.smsService.callback(mobileNumber, true);
        return NodeResult.ok(WaitSmsVerificationCodeNode.statuses.success, {
          smsVerificationCode: code,
          currentUrl
        });
      }

      if (submitResult.name === "submit_error") {
        const errorText = String(submitResult.value);
        if (errorText.includes("此电话号码近期已被使用。请稍后再试。")) {
          logger.warn("手机号近期已使用，跳过回调并回到 Codex OAuth");
          return buildRetryOrFail(ctx, "sms_verification_error", errorText, code);
        }
        if (resendAttempts < 1) {
          const resent = await clickResend(ctx);
          if (resent) {
            resendAttempts += 1;
            ctx.state.phoneSubmittedAt = new Date().toISOString();
            continue;
          }
        }
        await ctx.services.smsService.callback(mobileNumber, false);
        return NodeResult.fail("sms_verification_error", errorText, {
          smsVerificationCode: code,
          currentUrl
        });
      }

      await ctx.services.smsService.callback(mobileNumber, false);
      return NodeResult.fail("codex_consent_unexpected_url", `提交短信验证码后未进入 consent 页面: ${currentUrl}`, {
        smsVerificationCode: code,
        currentUrl
      });
    }
  }
}

async function waitForSmsCodeOrWhatsApp(ctx, mobileNumber) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  ctx.signal?.addEventListener?.("abort", onAbort, { once: true });
  try {
    const codePromise = ctx.services.smsService.getLatestVerificationCode(
      mobileNumber,
      ctx.state.phoneSubmittedAt,
      { signal: controller.signal }
    ).then((code) => ({
      type: "code",
      code
    }));
    const whatsappPromise = waitForWhatsAppResendButton(ctx, controller.signal, getSmsVerificationWaitTimeoutMs(ctx))
      .then((result) => result.matched
        ? {
          type: "whatsapp",
          detail: result.value
        }
        : {
          type: "code",
          code: ""
        });
    const result = await Promise.race([codePromise, whatsappPromise]);
    controller.abort();
    return result;
  } finally {
    ctx.signal?.removeEventListener?.("abort", onAbort);
    controller.abort();
  }
}

async function waitForWhatsAppResendButton(ctx, signal, timeoutMs) {
  return waitForAnyCondition([
    {
      name: "whatsapp_resend_button",
      check: () => detectWhatsAppResendButton(ctx)
    }
  ], {
    timeoutMs,
    intervalMs: 1000,
    label: "WhatsApp 重发按钮",
    signal
  });
}

async function detectWhatsAppResendButton(ctx) {
  return ctx.tabs.execute(() => {
    const button = Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit']"))
      .find((item) => {
        const text = getButtonText(item).toLowerCase().replace(/\s+/g, " ").trim();
        return isVisible(item)
          && text
          && (
            text.includes("重新发送 whatsapp 消息")
            || text.includes("重新发送 whatsapp")
            || text.includes("resend whatsapp message")
            || text.includes("resend whatsapp")
          );
      });
    if (!button) {
      return null;
    }
    return {
      text: getButtonText(button),
      type: button.getAttribute("type") || "",
      name: button.getAttribute("name") || "",
      value: button.getAttribute("value") || "",
      disabled: Boolean(button.disabled),
      ariaDisabled: button.getAttribute("aria-disabled") || ""
    };

    function getButtonText(element) {
      if (element instanceof HTMLInputElement) {
        return String(element.value || element.getAttribute("aria-label") || "").trim();
      }
      return String(element.textContent || element.getAttribute("aria-label") || "").trim();
    }

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      return style.visibility !== "hidden"
        && style.display !== "none"
        && element.getClientRects().length > 0;
    }
  });
}

async function submitSmsCode(ctx, code) {
  const selector = await resolveCodeInputSelector(ctx);
  const fillResult = await ctx.tabs.fill(selector, code);
  if (!fillResult.ok) {
    return { matched: true, name: "submit_error", value: "未找到短信验证码输入框" };
  }
  const actual = await ctx.tabs.getInputValue(selector);
  if (String(actual || "") !== String(code)) {
    await ctx.tabs.fill(selector, "");
    await ctx.tabs.fill(selector, code);
    const retryActual = await ctx.tabs.getInputValue(selector);
    if (String(retryActual || "") !== String(code)) {
      return { matched: true, name: "submit_error", value: `短信验证码填写不一致: expected=${code}, actual=${retryActual}` };
    }
  }

  await ctx.tabs.click("button[type='submit']");
  return waitForAnyCondition([
    {
      name: "submit_error",
      check: () => ctx.tabs.queryText("ul[class^='_errors_']")
    },
    {
      name: "consent_ready",
      check: () => ctx.tabs.urlContains("/sign-in-with-chatgpt/codex/consent")
    },
    {
      name: "about_you",
      check: async () => {
        const url = await ctx.tabs.getCurrentUrl();
        if (!url.includes("/about-you")) {
          return null;
        }
        return await isAboutYouReady(ctx) ? url : null;
      }
    }
  ], {
    timeoutMs: 30000,
    label: "短信验证码提交后的页面结果",
    signal: ctx.signal
  });
}

async function isAboutYouReady(ctx) {
  const nameInput = await ctx.tabs.query("input[name='name']");
  if (!nameInput) {
    return false;
  }
  const ageInput = await ctx.tabs.query("input[name='age']");
  if (ageInput) {
    return true;
  }
  return Boolean(await ctx.tabs.query("input[name='birthday']"));
}

async function resolveCodeInputSelector(ctx) {
  if (await ctx.tabs.query("input[name='code']")) {
    return "input[name='code']";
  }
  return "input[name='name']";
}

async function clickResend(ctx) {
  if (await detectWhatsAppResendButton(ctx)) {
    logger.warn("检测到 WhatsApp 重发按钮，跳过短信重发点击");
    return false;
  }
  const resendButton = await ctx.tabs.query("button[value='resend']");
  if (!resendButton) {
    return false;
  }
  logger.info("点击短信验证码重发按钮");
  await ctx.tabs.click("button[value='resend']");
  return true;
}

function buildRetryOrFail(ctx, failureStatus, message, code, extraData = {}) {
  const currentRetryCount = Number(ctx.state.smsVerificationRetryCount || 0);
  const maxRetryCount = Number(ctx.config.register.smsVerificationRetryAttempts ?? 5);
  if (currentRetryCount >= maxRetryCount) {
    return NodeResult.fail(failureStatus, message, {
      smsVerificationCode: code,
      ...extraData
    });
  }
  ctx.state.smsVerificationRetryCount = currentRetryCount + 1;
  return NodeResult.ok(WaitSmsVerificationCodeNode.statuses.retrySelectCodexAccount, {
    smsVerificationCode: code,
    smsVerificationRetryCount: ctx.state.smsVerificationRetryCount,
    ...extraData
  });
}

function getSmsVerificationWaitTimeoutMs(ctx) {
  const provider = normalizeSmsProvider(ctx.config.smsService?.provider);
  const providerConfig = provider
    ? ctx.config.smsService?.providers?.[provider] || {}
    : {};
  const seconds = Number(providerConfig.verificationCodeWaitTimeout || DEFAULT_SMS_WAIT_TIMEOUT_SECONDS);
  return Math.max(1, seconds) * 1000;
}

function normalizeSmsProvider(provider) {
  if (provider === "smsbower") {
    return "sms_bower";
  }
  if (provider === "manual_sms") {
    return "manual";
  }
  return provider;
}
