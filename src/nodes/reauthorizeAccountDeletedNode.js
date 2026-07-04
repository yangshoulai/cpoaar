import { RegisterNode, NodeResult } from "../core/flow.js";
import { createLogger } from "../core/logger.js";
import { ReauthorizeDeleteAccountNode } from "./reauthorizeDeleteAccountNode.js";

const logger = createLogger("node.reauth-deleted");

export class ReauthorizeAccountDeletedNode extends RegisterNode {
  static name = "reauthorize_account_deleted";
  static statuses = {
    deleteAccount: ReauthorizeDeleteAccountNode.statuses.ready
  };

  constructor() {
    super(ReauthorizeAccountDeletedNode.name, "账号停用处理");
  }

  async execute(ctx) {
    const record = ctx.state.historyRecord;
    if (!ctx.config.reauthorize?.deleteAccountOnDeactivated) {
      return NodeResult.fail("reauthorize_account_deactivated", "账号已停用，配置为直接终止流程");
    }
    if (!record) {
      return NodeResult.fail("reauthorize_account_delete_failed", "账号已停用，但上下文缺少账号记录，无法删除账号");
    }

    logger.warn("账号已停用，按配置删除账号", {
      email: record.emailAddress
    });
    return NodeResult.ok(ReauthorizeAccountDeletedNode.statuses.deleteAccount, {
      reauthorizeDeleteReason: "重新授权发现账号已停用"
    });
  }
}
