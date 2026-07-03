import { RegisterNode, NodeResult, buildFlowStoppedResult, isFlowStopped } from "../core/flow.js";
import { waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("node.sms-code");

export class WaitSmsVerificationCodeNode extends RegisterNode {
  static name = "wait_sms_verification_code";
  static statuses = {
    success: "phone_verified",
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
      const code = await ctx.services.smsService.getLatestVerificationCode(
        mobileNumber,
        ctx.state.phoneSubmittedAt,
        { signal: ctx.signal }
      );
      if (isFlowStopped(ctx)) {
        return buildFlowStoppedResult();
      }
      if (!code) {
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
    }
  ], {
    timeoutMs: 30000,
    label: "短信验证码提交后的页面结果",
    signal: ctx.signal
  });
}

async function resolveCodeInputSelector(ctx) {
  if (await ctx.tabs.query("input[name='code']")) {
    return "input[name='code']";
  }
  return "input[name='name']";
}

async function clickResend(ctx) {
  const resendButton = await ctx.tabs.query("button[value='resend']");
  if (!resendButton) {
    return false;
  }
  logger.info("点击短信验证码重发按钮");
  await ctx.tabs.click("button[value='resend']");
  return true;
}

function buildRetryOrFail(ctx, failureStatus, message, code) {
  const currentRetryCount = Number(ctx.state.smsVerificationRetryCount || 0);
  const maxRetryCount = Number(ctx.config.register.smsVerificationRetryAttempts || 5);
  if (currentRetryCount >= maxRetryCount) {
    return NodeResult.fail(failureStatus, message, {
      smsVerificationCode: code
    });
  }
  ctx.state.smsVerificationRetryCount = currentRetryCount + 1;
  return NodeResult.ok(WaitSmsVerificationCodeNode.statuses.retrySelectCodexAccount, {
    smsVerificationCode: code,
    smsVerificationRetryCount: ctx.state.smsVerificationRetryCount
  });
}
