import { RegisterNode, NodeResult } from "../core/flow.js";

export class GrokRegisterPlaceholderNode extends RegisterNode {
  static name = "grok_register_placeholder";
  static statuses = {
    pending: "grok_register_flow_pending"
  };

  constructor() {
    super(GrokRegisterPlaceholderNode.name, "Grok 注册流程");
  }

  async execute() {
    return NodeResult.fail(
      GrokRegisterPlaceholderNode.statuses.pending,
      "Grok 注册流程已接入运行模式，但具体注册节点尚未配置"
    );
  }
}
