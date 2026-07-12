import { RegisterNode, NodeResult } from "../core/flow.js";
import { waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("node.create-password");

export class CreatePasswordNode extends RegisterNode {
  static name = "create_password";
  static statuses = {
    success: "password_created",
    aboutYouReady: "password_created_about_you_ready",
    phoneVerificationReady: "password_created_phone_verification_ready"
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
    return NodeResult.ok(CreatePasswordNode.statuses.success, {
      emailSubmittedAt: new Date().toISOString(),
      currentUrl: await ctx.tabs.getCurrentUrl()
    });
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
