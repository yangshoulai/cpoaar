import { RegisterNode, NodeResult } from "../core/flow.js";
import { createLogger } from "../core/logger.js";
import { clearLogs } from "../core/storage.js";
import { isGrokRegisterMode } from "../core/runModes.js";

const logger = createLogger("node.startup");

export class StartupInitializeNode extends RegisterNode {
  static name = "startup_initialize";
  static statuses = {
    success: "startup_initialized"
  };

  constructor() {
    super(StartupInitializeNode.name, "启动初始化");
  }

  async execute(ctx) {
    await clearLogs();
    logger.info("启动初始化：日志已清理");
    if (isGrokRegisterMode(ctx.config.register?.mode)) {
      logger.info("Grok 注册模式：跳过 OpenAI/ChatGPT Cookie 清理");
    } else {
      logger.info("清理 OpenAI/ChatGPT Cookie 并关闭相关标签页");
      await ctx.tabs.resetOpenAiSession();
    }
    logger.info("启动初始化：预初始化 OutlookMail 会话");
    await ctx.services.emailService.initialize();
    return NodeResult.ok(StartupInitializeNode.statuses.success, {
      initializedAt: new Date().toISOString()
    });
  }
}
