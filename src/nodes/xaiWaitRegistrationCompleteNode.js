import { RegisterNode, NodeResult } from "../core/flow.js";
import { waitForAnyCondition } from "../core/browser.js";

export class XAiWaitRegistrationCompleteNode extends RegisterNode {
  static name = "xai_wait_registration_complete";
  static statuses = {
    success: "xai_registration_completed"
  };

  constructor() {
    super(XAiWaitRegistrationCompleteNode.name, "等待 xAI 注册完成");
  }

  async execute(ctx) {
    const result = await waitForAnyCondition([
      {
        name: "account_page",
        check: async () => {
          const currentUrl = await ctx.tabs.getCurrentUrl();
          return isXAiAccountPage(currentUrl) ? currentUrl : null;
        }
      }
    ], {
      timeoutMs: 60000,
      label: "xAI 注册完成账号页",
      signal: ctx.signal
    });
    if (!result.matched) {
      return NodeResult.fail("xai_registration_complete_timeout", `等待 xAI /account 页面超时: ${await ctx.tabs.getCurrentUrl()}`);
    }
    return NodeResult.ok(XAiWaitRegistrationCompleteNode.statuses.success, {
      currentUrl: result.value
    });
  }
}

function isXAiAccountPage(value) {
  try {
    const url = new URL(value);
    return url.hostname === "accounts.x.ai" && url.pathname.startsWith("/account");
  } catch {
    return false;
  }
}
