import { RegisterNode, NodeResult } from "../core/flow.js";
import { sleep, waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";
import { getPageTextTerms } from "../core/pageText.js";
import { clickVisibleButtonByText, findVisibleButtonByText, XAI_SIGN_UP_URL } from "./xaiHelpers.js";

const logger = createLogger("node.xai-signup");
const EMAIL_ENTRY_BUTTON_KEYWORDS = getPageTextTerms("xaiEmailEntry");
const EMAIL_ENTRY_CLICK_MAX_ATTEMPTS = 2;
const EMAIL_ENTRY_CLICK_DELAY_MS = 1000;

export class XAiOpenSignupPageNode extends RegisterNode {
  static name = "xai_open_signup_page";
  static statuses = {
    success: "xai_email_submitted"
  };

  constructor() {
    super(XAiOpenSignupPageNode.name, "打开 xAI 注册页面");
  }

  async execute(ctx) {
    const { account, emailAccount, reused } = await prepareAccountAndEmail(ctx);

    await ctx.tabs.open(XAI_SIGN_UP_URL);
    await ctx.tabs.waitForTabLoaded();
    await sleep(EMAIL_ENTRY_CLICK_DELAY_MS, ctx.signal);

    const emailEntryResult = await waitForAnyCondition([
      {
        name: "email_signup_button",
        check: () => findVisibleButtonByText(ctx, EMAIL_ENTRY_BUTTON_KEYWORDS)
      },
      {
        name: "email_input",
        check: () => ctx.tabs.findEmailInput()
      }
    ], {
      timeoutMs: 30000,
      label: "xAI 邮箱注册按钮",
      signal: ctx.signal
    });
    if (!emailEntryResult.matched) {
      return NodeResult.fail("xai_signup_email_button_missing", `未找到使用邮箱注册按钮或邮箱输入框: ${await ctx.tabs.getCurrentUrl()}`);
    }

    if (emailEntryResult.name === "email_signup_button") {
      const entryResult = await clickEmailEntryButtonAndWaitForInput(ctx);
      if (!entryResult.ok) {
        return NodeResult.fail(entryResult.status, entryResult.error, entryResult.data || {});
      }
    }

    const fillResult = await ctx.tabs.fillEmailInput(emailAccount.emailAddress);
    if (!fillResult.ok) {
      return NodeResult.fail("xai_signup_email_input_missing", "xAI 邮箱输入失败");
    }

    const submittedAt = new Date().toISOString();
    const submitResult = await clickXAiEmailSubmitButton(ctx);
    if (!submitResult.ok) {
      return NodeResult.fail("xai_signup_submit_failed", "未找到或无法点击 xAI 注册提交按钮");
    }

    logger.info("xAI 注册邮箱已提交", {
      email: emailAccount.emailAddress,
      reused,
      submitButton: submitResult.button?.text || ""
    });
    return NodeResult.ok(XAiOpenSignupPageNode.statuses.success, {
      account,
      emailAccount,
      emailSubmittedAt: submittedAt,
      currentUrl: await ctx.tabs.getCurrentUrl()
    });
  }
}

async function clickEmailEntryButtonAndWaitForInput(ctx) {
  for (let attempt = 1; attempt <= EMAIL_ENTRY_CLICK_MAX_ATTEMPTS; attempt += 1) {
    const existingInput = await ctx.tabs.findEmailInput();
    if (existingInput) {
      return {
        ok: true,
        attempts: attempt - 1
      };
    }

    const clickEmailButton = await clickVisibleButtonByText(ctx, EMAIL_ENTRY_BUTTON_KEYWORDS);
    if (!clickEmailButton.ok) {
      return {
        ok: false,
        status: "xai_signup_email_button_missing",
        error: "使用邮箱注册/登录按钮点击失败"
      };
    }

    const emailInputResult = await waitForEmailInput(ctx, 15000);
    if (emailInputResult.matched) {
      return {
        ok: true,
        attempts: attempt,
        button: clickEmailButton.button
      };
    }

    logger.warn("点击 xAI 邮箱入口后未出现邮箱输入框", {
      attempt,
      maxAttempts: EMAIL_ENTRY_CLICK_MAX_ATTEMPTS,
      currentUrl: await ctx.tabs.getCurrentUrl()
    });
    if (attempt < EMAIL_ENTRY_CLICK_MAX_ATTEMPTS) {
      await sleep(EMAIL_ENTRY_CLICK_DELAY_MS, ctx.signal);
    }
  }

  return {
    ok: false,
    status: "xai_signup_email_input_missing",
    error: `未找到 xAI 邮箱输入框: ${await ctx.tabs.getCurrentUrl()}`
  };
}

async function waitForEmailInput(ctx, timeoutMs) {
  return waitForAnyCondition([
    {
      name: "email_input",
      check: () => ctx.tabs.findEmailInput()
    }
  ], {
    timeoutMs,
    label: "xAI 邮箱输入框",
    signal: ctx.signal
  });
}

async function prepareAccountAndEmail(ctx) {
  if (ctx.state.account?.emailAddress) {
    const account = ctx.state.account;
    const emailAccount = ctx.state.emailAccount?.emailAddress
      ? ctx.state.emailAccount
      : buildFallbackEmailAccount(account.emailAddress);
    ctx.state.account = account;
    ctx.state.emailAccount = emailAccount;
    logger.info("复用已有 xAI 注册邮箱重试", {
      email: emailAccount.emailAddress,
      name: account.name,
      birthDate: account.birthDate?.value || ""
    });
    return {
      account,
      emailAccount,
      reused: true
    };
  }

  const account = ctx.services.accountService.createAccount();
  const emailAccount = await ctx.services.emailService.generateEmailAddress();
  account.emailAddress = emailAccount.emailAddress;
  ctx.state.account = account;
  ctx.state.emailAccount = emailAccount;

  logger.info("xAI 账号和邮箱已生成", {
    email: emailAccount.emailAddress,
    name: account.name,
    birthDate: account.birthDate?.value || ""
  });
  return {
    account,
    emailAccount,
    reused: false
  };
}

function buildFallbackEmailAccount(emailAddress) {
  const normalizedEmail = String(emailAddress || "").toLowerCase();
  const isOutlookAddress = /@(outlook|hotmail|live)\./.test(normalizedEmail);
  return {
    emailAddress,
    attributes: {
      mode: isOutlookAddress ? "outlook" : "temp",
      reusedFromSnapshot: true
    }
  };
}

async function clickXAiEmailSubmitButton(ctx) {
  const preciseResult = await ctx.tabs.execute((keywords, excludeKeywords) => {
    const button = Array.from(document.querySelectorAll("button"))
      .find((item) => {
        const text = String(item.textContent || "").trim().toLowerCase();
        return isClickable(item)
          && !excludeKeywords.some((keyword) => keyword && text.includes(keyword))
          && keywords.some((keyword) => keyword && text.includes(keyword));
      });
    if (!button) {
      return { ok: false, button: null };
    }
    button.scrollIntoView({ block: "center", inline: "center" });
    button.click();
    return {
      ok: true,
      button: {
        text: String(button.textContent || "").trim(),
        type: button.getAttribute("type") || "",
        name: button.getAttribute("name") || ""
      }
    };

    function isClickable(element) {
      const style = window.getComputedStyle(element);
      return style.visibility !== "hidden"
        && style.display !== "none"
        && element.getClientRects().length > 0
        && !element.disabled
        && element.getAttribute("aria-disabled") !== "true";
    }
  }, [
    getPageTextTerms("xaiEmailSubmit").map((term) => term.toLowerCase()),
    getPageTextTerms("xaiEmailEntryExclude").map((term) => term.toLowerCase())
  ]);
  if (preciseResult.ok) {
    return preciseResult;
  }
  return clickVisibleButtonByText(ctx, getPageTextTerms("xaiEmailSubmit"), {
    excludeKeywords: getPageTextTerms("xaiEmailEntryExclude")
  });
}
