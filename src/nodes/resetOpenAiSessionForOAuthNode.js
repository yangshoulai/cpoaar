import { RegisterNode, NodeResult } from "../core/flow.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("node.reset-openai-oauth-session");

export class ResetOpenAiSessionForOAuthNode extends RegisterNode {
  static name = "reset_openai_session_for_oauth";
  static statuses = {
    success: "openai_oauth_session_reset"
  };

  constructor() {
    super(ResetOpenAiSessionForOAuthNode.name, "清理会话并重新 OAuth");
  }

  async execute(ctx) {
    try {
      await ctx.tabs.resetOpenAiSession();
    } catch (error) {
      return NodeResult.fail("openai_oauth_session_reset_failed", `清理 OpenAI 会话失败: ${formatError(error)}`);
    }
    const reauthorizationAt = new Date().toISOString();
    logger.info("OpenAI 注册完成，已清理会话并准备重新 OAuth 登录", {
      email: ctx.state.account?.emailAddress || "",
      reauthorizationAt
    });
    return NodeResult.ok(ResetOpenAiSessionForOAuthNode.statuses.success, {
      openAiFreshOauthReauthorizationAt: reauthorizationAt
    });
  }
}

function formatError(error) {
  return `${error?.name || "Error"}: ${error?.message || String(error)}`;
}
