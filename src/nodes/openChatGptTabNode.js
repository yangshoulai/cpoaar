import { RegisterNode, NodeResult } from "../core/flow.js";
import { waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("node.open-chatgpt");

export class OpenChatGptTabNode extends RegisterNode {
  static name = "open_chatgpt_tab";
  static statuses = {
    success: "chatgpt_tab_opened"
  };

  constructor() {
    super(OpenChatGptTabNode.name, "打开 ChatGPT");
  }

  async execute(ctx) {
    await ctx.tabs.navigate("https://chatgpt.com/");
    const waitResult = await waitForAnyCondition([
      {
        name: "email_input",
        check: () => ctx.tabs.findEmailInput()
      },
      {
        name: "signup_button",
        check: () => ctx.tabs.findSignupButton()
      }
    ], {
      timeoutMs: 30000,
      label: "打开 ChatGPT 后等待注册入口"
    });

    const currentUrl = await ctx.tabs.getCurrentUrl();
    if (!isTargetChatGptUrl(currentUrl)) {
      return NodeResult.fail("chatgpt_tab_open_failed", `当前地址不是 ChatGPT 目标地址: ${currentUrl}`);
    }
    if (!waitResult.matched) {
      return NodeResult.fail("chatgpt_tab_open_failed", `未找到 ChatGPT 注册按钮或邮箱输入框: ${currentUrl}`);
    }

    logger.info("ChatGPT 注册入口已就绪", {
      entry: waitResult.name,
      currentUrl
    });
    return NodeResult.ok(OpenChatGptTabNode.statuses.success, {
      currentUrl
    });
  }
}

function isTargetChatGptUrl(url) {
  try {
    return new URL(url).hostname === "chatgpt.com";
  } catch {
    return false;
  }
}
