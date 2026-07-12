import { RegisterNode, NodeResult } from "../core/flow.js";
import { waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("node.phone-first-email");

export class PhoneFirstAddEmailNode extends RegisterNode {
  static name = "phone_first_add_email";
  static statuses = {
    success: "phone_first_email_submitted"
  };

  constructor() {
    super(PhoneFirstAddEmailNode.name, "邮箱验证");
  }

  async execute(ctx) {
    const account = ctx.state.account;
    if (!account) {
      return NodeResult.fail("phone_first_add_email_failed", "上下文缺少账号信息");
    }
    const emailAccount = await prepareEmail(ctx);

    const ready = await waitForAnyCondition([
      {
        name: "add_email_ready",
        check: async () => {
          const currentUrl = await ctx.tabs.getCurrentUrl();
          if (!currentUrl.includes("/add-email")) {
            return null;
          }
          return ctx.tabs.query("input[type='email'], input[name='email']");
        }
      },
      {
        name: "email_input",
        check: () => ctx.tabs.query("input[type='email'], input[name='email']")
      }
    ], {
      timeoutMs: 30000,
      label: "手机优先绑定邮箱页面",
      signal: ctx.signal
    });
    if (!ready.matched) {
      return NodeResult.fail("phone_first_add_email_failed", `未进入绑定邮箱页面: ${await ctx.tabs.getCurrentUrl()}`);
    }

    const selector = await resolveEmailInputSelector(ctx);
    const fillResult = await ctx.tabs.fill(selector, emailAccount.emailAddress);
    if (!fillResult.ok) {
      return NodeResult.fail("phone_first_add_email_failed", "绑定邮箱输入失败");
    }

    const submittedAt = new Date().toISOString();
    ctx.state.emailSubmittedAt = submittedAt;
    await ctx.tabs.click("button[type='submit']");

    const codeReady = await waitForAnyCondition([
      {
        name: "email_code_input",
        check: () => ctx.tabs.query("input[name='code'], input[type='code']")
      },
      {
        name: "submit_error",
        check: () => findAddEmailError(ctx)
      }
    ], {
      timeoutMs: 30000,
      label: "绑定邮箱提交后的邮箱验证码页",
      signal: ctx.signal
    });
    const currentUrl = await ctx.tabs.getCurrentUrl();
    if (!codeReady.matched) {
      return NodeResult.fail("phone_first_add_email_failed", `提交绑定邮箱后未进入邮箱验证码页: ${currentUrl}`, {
        emailSubmittedAt: submittedAt,
        currentUrl
      });
    }
    if (codeReady.name === "submit_error") {
      return NodeResult.fail("phone_first_add_email_failed", String(codeReady.value?.text || codeReady.value || "绑定邮箱失败"), {
        emailSubmittedAt: submittedAt,
        currentUrl
      });
    }

    logger.info("手机优先注册绑定邮箱已提交", {
      email: emailAccount.emailAddress
    });
    return NodeResult.ok(PhoneFirstAddEmailNode.statuses.success, {
      account,
      emailAccount,
      emailSubmittedAt: submittedAt,
      currentUrl
    });
  }
}

async function prepareEmail(ctx) {
  const excluded = collectExcludedEmails(ctx);
  const previousEmail = ctx.state.emailAccount?.emailAddress || ctx.state.account?.emailAddress || "";
  const emailAccount = await generateFreshEmail(ctx, excluded);
  ctx.state.emailAccount = emailAccount;
  ctx.state.account.emailAddress = emailAccount.emailAddress;
  ctx.state.account.emailVerificationCode = "";
  ctx.state.emailSubmittedAt = "";
  ctx.state.phoneFirstUsedEmailAddresses = [
    ...new Set([
      ...(ctx.state.phoneFirstUsedEmailAddresses || []),
      emailAccount.emailAddress
    ].filter(Boolean))
  ];
  logger.info("手机优先注册邮箱已生成", {
    email: emailAccount.emailAddress,
    previousEmail,
    excludedEmailCount: excluded.emailAddresses.length
  });
  return emailAccount;
}

async function generateFreshEmail(ctx, excluded) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const emailAccount = await ctx.services.emailService.generateEmailAddress({
      excludedEmailAddresses: excluded.emailAddresses,
      excludedAccountIds: excluded.accountIds
    });
    const normalizedEmail = normalizeEmail(emailAccount.emailAddress);
    if (!excluded.normalizedEmails.has(normalizedEmail)) {
      return emailAccount;
    }
    logger.warn("邮箱服务返回了已缓存邮箱，继续重新获取", {
      email: emailAccount.emailAddress,
      attempt,
      maxAttempts
    });
  }
  throw new Error("邮箱服务连续返回已缓存邮箱，无法获取新的绑定邮箱");
}

function collectExcludedEmails(ctx) {
  const emailAddresses = [
    ...(ctx.state.phoneFirstUsedEmailAddresses || []),
    ctx.state.emailAccount?.emailAddress || "",
    ctx.state.account?.emailAddress || ""
  ].filter(Boolean);
  const accountIds = [
    ctx.state.emailAccount?.attributes?.accountId || "",
    ctx.state.emailAccount?.attributes?.account?.id || ""
  ].filter(Boolean);
  return {
    emailAddresses: [...new Set(emailAddresses)],
    accountIds: [...new Set(accountIds.map((id) => String(id)))],
    normalizedEmails: new Set(emailAddresses.map((email) => normalizeEmail(email)).filter(Boolean))
  };
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

async function resolveEmailInputSelector(ctx) {
  if (await ctx.tabs.query("input[type='email']")) {
    return "input[type='email']";
  }
  return "input[name='email']";
}

async function findAddEmailError(ctx) {
  return ctx.tabs.execute(() => {
    const selectors = [
      "ul[class^='_errors_']",
      "ul[class*='_errors_']",
      "[role='alert']",
      "span[slot='errorMessage']"
    ];
    for (const selector of selectors) {
      const element = Array.from(document.querySelectorAll(selector)).find((item) => {
        const style = window.getComputedStyle(item);
        return style.visibility !== "hidden"
          && style.display !== "none"
          && item.textContent.trim();
      });
      if (element) {
        return {
          selector,
          text: element.textContent.trim()
        };
      }
    }
    return null;
  });
}
