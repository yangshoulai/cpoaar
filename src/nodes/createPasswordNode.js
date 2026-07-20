import { RegisterNode, NodeResult } from "../core/flow.js";
import { waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";
import { isOpenAiPhoneFirstRegisterFlow } from "../core/openAiRegisterFlows.js";

const logger = createLogger("node.create-password");

export class CreatePasswordNode extends RegisterNode {
  static name = "create_password";
  static statuses = {
    success: "password_created",
    aboutYouReady: "password_created_about_you_ready",
    phoneVerificationReady: "password_created_phone_verification_ready",
    retryStartup: "password_create_retry_startup"
  };

  constructor() {
    super(CreatePasswordNode.name, "创建密码");
  }

  async execute(ctx) {
    const account = ctx.state.account;
    if (!account?.password) {
      return NodeResult.fail("password_create_failed", "上下文缺少账号密码");
    }
    logger.info("填写初始密码");
    const fillResult = await ctx.tabs.fill("input[name='new-password']", account.password);
    if (!fillResult.ok) {
      return NodeResult.fail("password_create_failed", "未找到密码输入框");
    }
    await ctx.tabs.click("button[type='submit']");
    const waitResult = await waitForAnyCondition([
      {
        name: "phone_code_input",
        check: async () => {
          const url = await ctx.tabs.getCurrentUrl();
          if (!url.includes("/contact-verification") && !url.includes("/phone-verification")) {
            return null;
          }
          return ctx.tabs.query("input[name='code'], input[name='name']");
        }
      },
      {
        name: "email_code_input",
        check: () => ctx.tabs.query("input[name='code']")
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
        name: "phone_account_exists",
        check: () => findPhoneAccountExistsError(ctx)
      }
    ], {
      timeoutMs: 30000,
      label: "创建密码后等待验证码页或资料页"
    });
    if (!waitResult.matched) {
      return NodeResult.fail("password_create_failed", `创建密码后未进入验证码页或资料页: ${await ctx.tabs.getCurrentUrl()}`);
    }
    if (waitResult.name === "about_you") {
      return NodeResult.ok(CreatePasswordNode.statuses.aboutYouReady, {
        currentUrl: await ctx.tabs.getCurrentUrl()
      });
    }
    if (waitResult.name === "phone_code_input") {
      return NodeResult.ok(CreatePasswordNode.statuses.phoneVerificationReady, {
        phoneSubmittedAt: new Date().toISOString(),
        currentUrl: await ctx.tabs.getCurrentUrl()
      });
    }
    if (waitResult.name === "phone_account_exists") {
      const errorText = String(waitResult.value?.text || "与此电话号码相关联的帐户已存在");
      logger.warn("创建密码后检测到手机号已存在", {
        mobile: ctx.state.account?.mobile || "",
        error: waitResult.value
      });
      if (ctx.state.smsMobileNumber && ctx.services.smsService) {
        await ctx.services.smsService.callback(ctx.state.smsMobileNumber, false);
      }
      return buildPhoneFirstPhoneRetryOrFail(ctx, errorText, {
        currentUrl: await ctx.tabs.getCurrentUrl(),
        phoneAccountExistsError: waitResult.value || null
      });
    }
    return NodeResult.ok(CreatePasswordNode.statuses.success, {
      emailSubmittedAt: new Date().toISOString(),
      currentUrl: await ctx.tabs.getCurrentUrl()
    });
  }
}

function buildPhoneFirstPhoneRetryOrFail(ctx, message, data = {}) {
  if (!isOpenAiPhoneFirstRegisterFlow(ctx.config.register?.openAiRegisterFlow || ctx.state.openAiRegisterFlow)) {
    return NodeResult.fail("password_phone_account_exists", message, data);
  }

  const currentRetryCount = Number(ctx.state.phoneNumberRetryCount || 0);
  const maxRetryCount = Number(ctx.config.register.phoneNumberRetryAttempts ?? 1);
  if (currentRetryCount >= maxRetryCount) {
    return NodeResult.fail("password_phone_account_exists", message, {
      ...data,
      phoneNumberRetryCount: currentRetryCount
    });
  }

  const nextRetryCount = currentRetryCount + 1;
  ctx.state.phoneNumberRetryCount = nextRetryCount;
  return NodeResult.ok(CreatePasswordNode.statuses.retryStartup, {
    ...data,
    phoneNumberRetryCount: nextRetryCount
  });
}

async function findPhoneAccountExistsError(ctx) {
  return ctx.tabs.execute(() => {
    const keywords = [
      "与此电话号码相关联的帐户已存在",
      "与此电话号码相关联的账户已存在",
      "与该电话号码相关联的帐户已存在",
      "与该电话号码相关联的账户已存在",
      "an account already exists with this phone number",
      "an account associated with this phone number already exists",
      "account already exists for this phone number"
    ];
    const elements = Array.from(document.querySelectorAll([
      "[role='alert']",
      "[aria-live]",
      "ul[class^='_errors_']",
      "ul[class*='_errors_']",
      "span[slot='errorMessage']",
      "p",
      "div",
      "span",
      "li"
    ].join(",")));
    for (const element of elements) {
      if (!isVisible(element)) {
        continue;
      }
      const text = String(element.textContent || "").replace(/\s+/g, " ").trim();
      const normalized = text.toLowerCase();
      if (text && keywords.some((keyword) => normalized.includes(keyword.toLowerCase()))) {
        return {
          text,
          tagName: element.tagName,
          role: element.getAttribute("role") || "",
          ariaLive: element.getAttribute("aria-live") || "",
          className: String(element.className || "")
        };
      }
    }
    return null;

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      return style.visibility !== "hidden"
        && style.display !== "none"
        && element.getClientRects().length > 0;
    }
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
