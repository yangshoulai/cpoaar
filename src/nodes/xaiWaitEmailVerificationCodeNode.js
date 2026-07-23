import { RegisterNode, NodeResult, buildFlowStoppedResult, isFlowStopped } from "../core/flow.js";
import { sleep, waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";
import { getPageTextTerms } from "../core/pageText.js";
import { clickVisibleButtonByText, normalizeXAiVerificationCode } from "./xaiHelpers.js";

const logger = createLogger("node.xai-email-code");

export class XAiWaitEmailVerificationCodeNode extends RegisterNode {
  static name = "xai_wait_email_verification_code";
  static statuses = {
    success: "xai_email_verified"
  };

  constructor() {
    super(XAiWaitEmailVerificationCodeNode.name, "xAI 邮箱验证码");
  }

  async execute(ctx) {
    const readyResult = await waitForAnyCondition([
      {
        name: "code_input",
        check: () => ctx.tabs.query("input[name='code']")
      }
    ], {
      timeoutMs: 30000,
      label: "xAI 邮箱验证码输入框",
      signal: ctx.signal
    });
    if (readyResult.stopped || isFlowStopped(ctx)) {
      return buildFlowStoppedResult();
    }
    if (!readyResult.matched) {
      return NodeResult.fail("xai_email_code_input_missing", `未找到 xAI 邮箱验证码输入框: ${await ctx.tabs.getCurrentUrl()}`);
    }

    const timeoutMs = Number(ctx.config.register.verificationCodeWaitTimeout || 60) * 1000;
    const deadline = Date.now() + timeoutMs;
    const sentAfter = ctx.state.emailSubmittedAt || new Date(Date.now() - 60000).toISOString();

    while (Date.now() <= deadline) {
      if (isFlowStopped(ctx)) {
        return buildFlowStoppedResult();
      }
      const message = await ctx.services.emailService.searchFirstEmail(ctx.state.emailAccount, sentAfter, {
        purpose: "xai",
        signal: ctx.signal
      });
      if (isFlowStopped(ctx)) {
        return buildFlowStoppedResult();
      }
      const code = normalizeXAiVerificationCode(message?.verificationCode);
      if (!code) {
        logger.info("暂未获取到 xAI 邮箱验证码，等待下一轮", message ? {
          subject: message.subject || "",
          sender: message.sender || "",
          messageId: message.messageId || ""
        } : {});
        await sleep(5000, ctx.signal);
        continue;
      }

      ctx.state.account.emailVerificationCode = code;
      logger.info("xAI 邮箱验证码已获取", {
        code,
        rawCode: message.verificationCode || ""
      });
      const fillResult = await ctx.tabs.fill("input[name='code']", code);
      if (!fillResult.ok) {
        return NodeResult.fail("xai_email_code_input_missing", "xAI 邮箱验证码输入失败");
      }

      const verifiedResult = await waitForProfileForm(ctx, 6000);
      if (verifiedResult.matched) {
        return NodeResult.ok(XAiWaitEmailVerificationCodeNode.statuses.success, buildResultData(ctx, message, code));
      }

      logger.info("xAI 邮箱验证码未自动提交，尝试点击确认邮箱按钮");
      const confirmResult = await clickVisibleButtonByText(ctx, getPageTextTerms("xaiConfirmEmail"));
      if (!confirmResult.ok) {
        return NodeResult.fail("xai_email_verify_failed", "输入 xAI 邮箱验证码后未进入资料页，且未找到确认邮箱按钮", buildResultData(ctx, message, code));
      }

      const afterConfirmResult = await waitForProfileForm(ctx, 30000);
      if (!afterConfirmResult.matched) {
        return NodeResult.fail("xai_email_verify_failed", `确认 xAI 邮箱后未进入资料页: ${await ctx.tabs.getCurrentUrl()}`, buildResultData(ctx, message, code));
      }
      return NodeResult.ok(XAiWaitEmailVerificationCodeNode.statuses.success, buildResultData(ctx, message, code));
    }

    return NodeResult.fail("xai_email_code_timeout", `等待 xAI 邮箱验证码超时: ${timeoutMs / 1000} 秒`);
  }
}

async function waitForProfileForm(ctx, timeoutMs) {
  return waitForAnyCondition([
    {
      name: "profile_form",
      check: () => ctx.tabs.query("input[name='givenName']")
    }
  ], {
    timeoutMs,
    intervalMs: 300,
    label: "xAI 资料填写表单",
    signal: ctx.signal
  });
}

function buildResultData(ctx, message, code) {
  return {
    emailVerificationMessage: message,
    emailVerificationCode: code,
    emailAddress: ctx.state.account?.emailAddress || "",
  };
}
