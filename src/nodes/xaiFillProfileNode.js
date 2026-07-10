import { RegisterNode, NodeResult } from "../core/flow.js";
import { waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";
import { clickVisibleButtonByText } from "./xaiHelpers.js";

const logger = createLogger("node.xai-profile");

export class XAiFillProfileNode extends RegisterNode {
  static name = "xai_fill_profile";
  static statuses = {
    success: "xai_profile_submitted"
  };

  constructor() {
    super(XAiFillProfileNode.name, "xAI 资料填写");
  }

  async execute(ctx) {
    const account = ctx.state.account;
    if (!account) {
      return NodeResult.fail("xai_profile_failed", "上下文缺少 xAI 账号信息");
    }

    const readyResult = await waitForAnyCondition([
      {
        name: "profile_form",
        check: () => ctx.tabs.query("input[name='givenName']")
      }
    ], {
      timeoutMs: 30000,
      label: "xAI 资料填写表单",
      signal: ctx.signal
    });
    if (!readyResult.matched) {
      return NodeResult.fail("xai_profile_form_missing", `未找到 xAI 资料填写表单: ${await ctx.tabs.getCurrentUrl()}`);
    }

    logger.info("填写 xAI 资料", {
      email: account.emailAddress,
      givenName: account.firstName,
      familyName: account.lastName
    });
    const givenNameResult = await ctx.tabs.fill("input[name='givenName']", account.firstName || account.name || "");
    if (!givenNameResult.ok) {
      return NodeResult.fail("xai_profile_failed", "未找到 givenName 输入框");
    }
    const familyNameResult = await ctx.tabs.fill("input[name='familyName']", account.lastName || account.name || "");
    if (!familyNameResult.ok) {
      return NodeResult.fail("xai_profile_failed", "未找到 familyName 输入框");
    }
    const passwordResult = await ctx.tabs.fill("input[name='password']", account.password || "");
    if (!passwordResult.ok) {
      return NodeResult.fail("xai_profile_failed", "未找到 password 输入框");
    }

    const submitReady = await waitForAnyCondition([
      {
        name: "submit_ready",
        check: () => findCompleteRegistrationButton(ctx)
      }
    ], {
      timeoutMs: 10000,
      intervalMs: 300,
      label: "xAI 完成注册按钮",
      signal: ctx.signal
    });
    if (!submitReady.matched) {
      return NodeResult.fail("xai_profile_submit_failed", "xAI 完成注册按钮不可用");
    }

    const submitResult = await clickVisibleButtonByText(ctx, ["完成注册", "complete registration", "sign up", "注册"]);
    if (!submitResult.ok) {
      return NodeResult.fail("xai_profile_submit_failed", "xAI 完成注册按钮点击失败");
    }
    logger.info("xAI 资料已提交", {
      submitButton: submitResult.button?.text || ""
    });
    return NodeResult.ok(XAiFillProfileNode.statuses.success, {
      currentUrl: await ctx.tabs.getCurrentUrl()
    });
  }
}

async function findCompleteRegistrationButton(ctx) {
  return ctx.tabs.execute(() => {
    const keywords = ["完成注册", "complete registration", "sign up", "注册"];
    const button = Array.from(document.querySelectorAll("button"))
      .find((item) => {
        const text = String(item.textContent || "").trim().toLowerCase();
        return keywords.some((keyword) => text.includes(keyword.toLowerCase()))
          && isClickable(item);
      });
    return button ? {
      text: String(button.textContent || "").trim(),
      disabled: button.disabled
    } : null;

    function isClickable(element) {
      const style = window.getComputedStyle(element);
      return style.visibility !== "hidden"
        && style.display !== "none"
        && element.getClientRects().length > 0
        && !element.disabled
        && element.getAttribute("aria-disabled") !== "true";
    }
  });
}
