import { RegisterNode, NodeResult } from "../core/flow.js";
import { createLogger } from "../core/logger.js";
import { deleteRegisteredAccount } from "../services/accountDeletionService.js";

const logger = createLogger("node.reauth-delete");

export class ReauthorizeDeleteAccountNode extends RegisterNode {
  static name = "reauthorize_delete_account";
  static statuses = {
    ready: "reauthorize_delete_account_ready",
    deleted: "reauthorize_account_deleted"
  };

  constructor() {
    super(ReauthorizeDeleteAccountNode.name, "删除账号");
  }

  async execute(ctx) {
    const record = ctx.state.historyRecord;
    if (!record) {
      return NodeResult.fail("reauthorize_account_delete_failed", "上下文缺少账号记录，无法删除账号");
    }
    const reason = ctx.state.reauthorizeDeleteReason || "重新授权删除账号";
    logger.warn("重新授权流程删除账号", {
      email: record.emailAddress || record.emailAccount?.emailAddress || "",
      reason
    });
    await deleteRegisteredAccount(ctx.config, record, {
      reason
    });
    return NodeResult.fail(ReauthorizeDeleteAccountNode.statuses.deleted, "账号已删除并终止流程", {
      reauthorizeDeleteReason: reason
    });
  }
}
