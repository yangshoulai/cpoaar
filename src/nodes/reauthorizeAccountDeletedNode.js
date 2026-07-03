import { RegisterNode, NodeResult } from "../core/flow.js";
import { createLogger } from "../core/logger.js";
import { deleteRegisteredAccount } from "../services/accountDeletionService.js";

const logger = createLogger("node.reauth-deleted");

export class ReauthorizeAccountDeletedNode extends RegisterNode {
  static name = "reauthorize_account_deleted";

  constructor() {
    super(ReauthorizeAccountDeletedNode.name, "账号停用处理");
  }

  async execute(ctx) {
    const record = ctx.state.historyRecord;
    if (!ctx.config.reauthorize?.deleteAccountOnDeactivated) {
      return NodeResult.fail("reauthorize_account_deactivated", "账号已停用，配置为直接终止流程");
    }
    if (!record) {
      return NodeResult.fail("reauthorize_account_delete_failed", "账号已停用，但上下文缺少历史记录，无法删除账号");
    }

    logger.warn("账号已停用，按配置删除账号", {
      email: record.emailAddress
    });
    await deleteRegisteredAccount(ctx.config, record, {
      reason: "重新授权发现账号已停用"
    });
    return NodeResult.fail("reauthorize_account_deleted", "账号已停用，已删除账号并终止流程");
  }
}
