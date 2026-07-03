import { RegisterNode, NodeResult } from "../core/flow.js";
import { waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("node.fill-email");

export class FillEmailAndSubmitNode extends RegisterNode {
  static name = "fill_email_and_submit";
  static statuses = {
    success: "email_submitted",
    smsReady: "email_submitted_sms_verification_ready",
    createPasswordReady: "email_submitted_create_password_ready"
  };

  constructor() {
    super(FillEmailAndSubmitNode.name, "填写邮箱");
  }

  async execute(ctx) {
    const { account, emailAccount } = await this._prepareAccountAndEmail(ctx);

    const emailInputResult = await this._ensureEmailInput(ctx);
    if (!emailInputResult.ok) {
      return NodeResult.fail("email_submit_failed", emailInputResult.error, {
        currentUrl: await ctx.tabs.getCurrentUrl()
      });
    }

    const fillResult = await ctx.tabs.fillEmailInput(emailAccount.emailAddress);
    if (!fillResult.ok) {
      return NodeResult.fail("email_submit_failed", `邮箱输入框不存在: ${await ctx.tabs.getCurrentUrl()}`);
    }

    const submittedAt = new Date().toISOString();
    const submitResult = await ctx.tabs.clickPrimarySubmitButton();
    if (!submitResult.ok) {
      return NodeResult.fail("email_submit_failed", `邮箱提交按钮不存在: ${await ctx.tabs.getCurrentUrl()}`);
    }

    const waitResult = await waitForAnyCondition([
      {
        name: "email_code_input",
        check: () => ctx.tabs.query("input[name='code']")
      },
      {
        name: "sms_verification_input",
        check: async () => {
          const url = await ctx.tabs.getCurrentUrl();
          if (!url.includes("/phone-verification")) {
            return null;
          }
          return ctx.tabs.query("input[name='code'], input[name='name']");
        }
      },
      {
        name: "create_password_input",
        check: async () => {
          const url = await ctx.tabs.getCurrentUrl();
          if (!url.includes("/create-account/password")) {
            return null;
          }
          return ctx.tabs.query("input[name='new-password']");
        }
      }
    ], {
      timeoutMs: 30000,
      label: "邮箱提交后的页面结果"
    });

    const data = {
      account,
      emailAccount,
      emailSubmittedAt: submittedAt,
      currentUrl: await ctx.tabs.getCurrentUrl()
    };

    if (!waitResult.matched) {
      return NodeResult.fail("email_verification_unexpected_url", `提交邮箱后未进入预期页面: ${data.currentUrl}`, data);
    }
    if (waitResult.name === "sms_verification_input") {
      return NodeResult.ok(FillEmailAndSubmitNode.statuses.smsReady, {
        ...data,
        phoneSubmittedAt: submittedAt
      });
    }
    if (waitResult.name === "create_password_input") {
      return NodeResult.ok(FillEmailAndSubmitNode.statuses.createPasswordReady, data);
    }
    return NodeResult.ok(FillEmailAndSubmitNode.statuses.success, data);
  }

  async _prepareAccountAndEmail(ctx) {
    if (ctx.state.reuseGeneratedEmailForLogin && ctx.state.account?.emailAddress) {
      const account = ctx.state.account;
      const emailAccount = ctx.state.emailAccount || {
        emailAddress: account.emailAddress
      };
      ctx.state.account = account;
      ctx.state.emailAccount = emailAccount;
      ctx.state.reuseGeneratedEmailForLogin = false;
      logger.info("复用已生成邮箱进行登录", {
        email: emailAccount.emailAddress,
        name: account.name,
        age: account.age,
        birthDate: account.birthDate?.value || ""
      });
      return { account, emailAccount };
    }

    const account = ctx.services.accountService.createAccount();
    const emailAccount = await ctx.services.emailService.generateEmailAddress();
    account.emailAddress = emailAccount.emailAddress;
    ctx.state.account = account;
    ctx.state.emailAccount = emailAccount;
    ctx.state.reuseGeneratedEmailForLogin = false;
    logger.info("账号和邮箱已生成", {
      email: emailAccount.emailAddress,
      name: account.name,
      age: account.age,
      birthDate: account.birthDate?.value || ""
    });
    return { account, emailAccount };
  }

  async _ensureEmailInput(ctx) {
    const currentPageResult = await this._ensureEmailInputOnCurrentPage(ctx);
    if (currentPageResult.ok) {
      return currentPageResult;
    }

    logger.info("当前页面没有邮箱输入框或注册按钮，重新打开 ChatGPT 注册入口", {
      currentUrl: await ctx.tabs.getCurrentUrl()
    });
    await ctx.tabs.navigate("https://chatgpt.com/");
    return this._ensureEmailInputOnCurrentPage(ctx);
  }

  async _ensureEmailInputOnCurrentPage(ctx) {
    const existedInput = await ctx.tabs.findEmailInput();
    if (existedInput) {
      logger.info("找到邮箱输入框", {
        id: existedInput.id,
        name: existedInput.name,
        type: existedInput.type
      });
      return { ok: true };
    }

    const signupButton = await ctx.tabs.findSignupButton();
    if (!signupButton) {
      return { ok: false, error: `未找到邮箱输入框或注册按钮: ${await ctx.tabs.getCurrentUrl()}` };
    }

    logger.info("邮箱输入框未出现，点击注册按钮", {
      text: signupButton.text,
      testId: signupButton.testId
    });
    const clickResult = await ctx.tabs.clickSignupButton();
    if (!clickResult.ok) {
      return { ok: false, error: "注册按钮点击失败" };
    }

    const waitInputResult = await waitForAnyCondition([
      {
        name: "email_input",
        check: () => ctx.tabs.findEmailInput()
      }
    ], {
      timeoutMs: 10000,
      label: "点击注册按钮后等待邮箱输入框"
    });
    if (!waitInputResult.matched) {
      return { ok: false, error: `点击注册按钮后未出现邮箱输入框: ${await ctx.tabs.getCurrentUrl()}` };
    }
    return { ok: true };
  }
}
