import { RegisterNode, NodeResult, buildFlowStoppedResult, isFlowStopped } from "../core/flow.js";
import { waitForAnyCondition, sleep } from "../core/browser.js";
import { createLogger } from "../core/logger.js";
import { containsPageText } from "../core/pageText.js";
import { isOpenAiReauthorizeMode } from "../core/runModes.js";
import {
  clickOneTimeCodeLoginButton,
  findAccountDeactivatedMessage,
  findEmailVerificationCodeInput,
  findOneTimeCodeLoginButton,
  hasPhoneChallenge
} from "./reauthorizeHelpers.js";

const logger = createLogger("node.email-code");

export class WaitEmailVerificationCodeNode extends RegisterNode {
  static name = "wait_email_verification_code";
  static statuses = {
    retryCurrent: "email_verification_retry_current_node",
    success: "email_verified",
    chatgptReady: "email_verified_chatgpt_ready",
    needsPhone: "codex_oauth_needs_phone",
    consent: "codex_oauth_consent_ready",
    freshOauthConsent: "openai_fresh_oauth_consent_ready",
    accountDeleted: "reauthorize_account_deactivated_ready"
  };

  constructor() {
    super(WaitEmailVerificationCodeNode.name, "邮箱验证码");
  }

  async execute(ctx) {
    let readyResult = await waitForAnyCondition([
      {
        name: "try_again",
        check: () => ctx.tabs.query("button[data-dd-action-name='Try again']")
      },
      {
        name: "needs_phone",
        check: async () => await hasPhoneChallenge(ctx) ? "phone_challenge" : null
      },
      {
        name: "code_input",
        check: () => findEmailVerificationCodeInput(ctx)
      },
      {
        name: "one_time_code_login",
        check: () => findOneTimeCodeLoginButton(ctx)
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
      timeoutMs: 10000,
      label: "邮箱验证码节点入口状态",
      signal: ctx.signal
    });

    if (readyResult.stopped || isFlowStopped(ctx)) {
      return buildFlowStoppedResult();
    }
    if (!readyResult.matched) {
      return NodeResult.fail("email_verification_failed", "邮箱验证码页未出现验证码输入框，也未出现 Try again 按钮");
    }
    if (readyResult.name === "try_again") {
      await ctx.tabs.click("button[data-dd-action-name='Try again']");
      return NodeResult.ok(WaitEmailVerificationCodeNode.statuses.retryCurrent);
    }
    if (readyResult.name === "one_time_code_login") {
      const switchResult = await clickOneTimeCodeLoginButton(ctx);
      if (switchResult?.state === "code_input") {
        readyResult = {
          matched: true,
          name: "code_input",
          value: switchResult.codeInput
        };
      } else if (switchResult?.state === "clicked") {
        ctx.state.emailSubmittedAt = new Date().toISOString();
        logger.info("邮箱验证码节点切换为一次性验证码登录", { button: switchResult.button });
        return NodeResult.ok(WaitEmailVerificationCodeNode.statuses.retryCurrent, {
          emailSubmittedAt: ctx.state.emailSubmittedAt,
          currentUrl: await ctx.tabs.getCurrentUrl()
        });
      } else {
        return NodeResult.fail("email_verification_failed", "未能点击一次性验证码登录按钮");
      }
    }
    if (readyResult.name === "account_deactivated") {
      return buildAccountDeactivatedResult(ctx);
    }
    if (readyResult.name === "needs_phone") {
      return NodeResult.ok(WaitEmailVerificationCodeNode.statuses.needsPhone);
    }
    if (readyResult.name === "consent") {
      return buildConsentReadyResult(ctx);
    }

    const timeoutMs = Number(ctx.config.register.verificationCodeWaitTimeout || 60) * 1000;
    const deadline = Date.now() + timeoutMs;
    let sentAfter = ctx.state.emailSubmittedAt || new Date(Date.now() - 60000).toISOString();

    while (Date.now() <= deadline) {
      if (isFlowStopped(ctx)) {
        return buildFlowStoppedResult();
      }
      const message = await ctx.services.emailService.searchFirstEmail(ctx.state.emailAccount, sentAfter, {
        signal: ctx.signal
      });
      if (isFlowStopped(ctx)) {
        return buildFlowStoppedResult();
      }
      if (!message?.verificationCode) {
        logger.info("暂未获取到邮箱验证码，等待下一轮");
        await sleep(5000, ctx.signal);
        continue;
      }

      const code = message.verificationCode;
      ctx.state.account.emailVerificationCode = code;
      logger.info("邮箱验证码已获取", { code });
      const inputSelector = readyResult.value?.selector || await resolveEmailCodeInputSelector(ctx);
      if (!inputSelector) {
        return NodeResult.fail("email_verification_failed", "邮箱验证码输入框已消失", {
          emailVerificationMessage: message,
          emailVerificationCode: code,
          currentUrl: await ctx.tabs.getCurrentUrl()
        });
      }
      await ctx.tabs.fill(inputSelector, code);
      await clickEmailCodeSubmitButton(ctx);

      const submitResult = await waitForAnyCondition([
        {
          name: "account_create_error",
          check: () => queryTextContains(ctx, "span[slot='errorMessage']", "accountCreateFailed")
        },
        {
          name: "invalid_code",
          check: () => queryTextContains(ctx, "span[slot='errorMessage']", "invalidVerificationCode")
        },
        {
          name: "account_deactivated",
          check: () => findAccountDeactivatedMessage(ctx)
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
        },
        {
          name: "chatgpt_ready",
          check: () => isChatGptReady(ctx)
        },
        {
          name: "needs_phone",
          check: async () => await hasPhoneChallenge(ctx) ? "phone_challenge" : null
        },
        {
          name: "consent",
          check: () => ctx.tabs.urlContains("/sign-in-with-chatgpt/codex/consent")
        }
      ], {
        timeoutMs: 30000,
        label: "邮箱验证码提交后的页面结果",
        signal: ctx.signal
      });

      if (submitResult.stopped || isFlowStopped(ctx)) {
        return buildFlowStoppedResult();
      }
      const data = {
        emailVerificationMessage: message,
        emailVerificationCode: code,
        currentUrl: await ctx.tabs.getCurrentUrl()
      };

      if (!submitResult.matched) {
        return NodeResult.fail("email_verification_failed", "提交邮箱验证码后等待页面结果超时", data);
      }
      if (submitResult.name === "account_create_error") {
        return NodeResult.fail("account_create_failed", "无法创建你的帐户", data);
      }
      if (submitResult.name === "invalid_code") {
        logger.warn("邮箱验证码无效，点击重新发送后继续等待");
        sentAfter = new Date().toISOString();
        await clickEmailCodeResendButton(ctx);
        continue;
      }
      if (submitResult.name === "account_deactivated") {
        return buildAccountDeactivatedResult(ctx, data);
      }
      if (submitResult.name === "chatgpt_ready") {
        return NodeResult.ok(WaitEmailVerificationCodeNode.statuses.chatgptReady, data);
      }
      if (submitResult.name === "needs_phone") {
        return NodeResult.ok(WaitEmailVerificationCodeNode.statuses.needsPhone, data);
      }
      if (submitResult.name === "consent") {
        return buildConsentReadyResult(ctx, data);
      }
      return NodeResult.ok(WaitEmailVerificationCodeNode.statuses.success, data);
    }

    return NodeResult.fail("email_verification_code_timeout", `等待邮箱验证码超时: ${timeoutMs / 1000} 秒`);
  }
}

async function resolveEmailCodeInputSelector(ctx) {
  const input = await findEmailVerificationCodeInput(ctx);
  return input?.selector || "";
}

async function clickEmailCodeSubmitButton(ctx) {
  if (await ctx.tabs.query("button[type='submit'][value='validate']")) {
    await ctx.tabs.click("button[type='submit'][value='validate']");
    return;
  }
  await ctx.tabs.click("button[type='submit']");
}

async function clickEmailCodeResendButton(ctx) {
  if (await ctx.tabs.query("button[type='submit'][value='resend']")) {
    await ctx.tabs.click("button[type='submit'][value='resend']");
    return;
  }
  if (await ctx.tabs.query("button[value='resend']")) {
    await ctx.tabs.click("button[value='resend']");
  }
}

function buildAccountDeactivatedResult(ctx, data = {}) {
  if (isOpenAiReauthorizeMode(ctx.config.register?.mode)) {
    return NodeResult.ok(WaitEmailVerificationCodeNode.statuses.accountDeleted, data);
  }
  return NodeResult.fail("account_create_failed", "账号已停用: account_deactivated", data);
}

function buildConsentReadyResult(ctx, data = {}) {
  return NodeResult.ok(
    ctx.state.openAiFreshOauthReauthorizationAt
      ? WaitEmailVerificationCodeNode.statuses.freshOauthConsent
      : WaitEmailVerificationCodeNode.statuses.consent,
    data
  );
}

async function queryTextContains(ctx, selector, pageTextName) {
  const text = await ctx.tabs.queryText(selector);
  return text && containsPageText(text, pageTextName) ? text : null;
}

async function isChatGptReady(ctx) {
  const profileButton = await ctx.tabs.query("div[data-testid='accounts-profile-button']");
  if (profileButton) {
    return profileButton;
  }
  const url = await ctx.tabs.getCurrentUrl();
  if (!isChatGptHomeUrl(url)) {
    return null;
  }
  return queryTextContains(ctx, "p", "chatGptReady");
}

function isChatGptHomeUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === "chatgpt.com" && url.pathname === "/";
  } catch {
    return false;
  }
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
