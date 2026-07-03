import { deleteRegisterHistory } from "../core/storage.js";
import { createLogger } from "../core/logger.js";
import { createServices } from "./index.js";

const logger = createLogger("account-deletion");

export async function deleteRegisteredAccount(config, record, {
  reason = "手动删除"
} = {}) {
  if (!record?.id) {
    throw new Error("删除账号失败：缺少历史记录 ID");
  }

  const services = createServices(config);
  logger.info("开始删除历史账号", {
    email: record.emailAddress,
    reason
  });
  await services.emailService.deleteAccount(record);

  await deleteRegisterHistory(record.id);
  logger.info("历史账号删除完成", {
    email: record.emailAddress,
    reason
  });
}
