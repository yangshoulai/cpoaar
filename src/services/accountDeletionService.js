import { deleteRegisterHistory } from "../core/storage.js";
import { createLogger } from "../core/logger.js";
import { createServices } from "./index.js";

const logger = createLogger("account-deletion");

export async function deleteRegisteredAccount(config, record, {
  reason = "手动删除"
} = {}) {
  const emailAddress = record?.emailAddress || record?.emailAccount?.emailAddress || "";
  if (!emailAddress) {
    throw new Error("删除账号失败：缺少邮箱地址");
  }

  const services = createServices(config);
  logger.info("开始删除账号", {
    email: emailAddress,
    reason
  });
  const errors = [];
  try {
    await services.emailService.deleteAccount(record);
  } catch (error) {
    errors.push(`邮箱服务删除失败：${error.message}`);
    logger.warn("邮箱服务删除账号失败", {
      email: emailAddress,
      reason,
      error: error.message
    });
  }

  try {
    const result = await services.accountManagementService.deleteAccount(record);
    if (!result.success) {
      throw new Error(result.error || `CPA 删除响应异常: ${result.status}`);
    }
  } catch (error) {
    errors.push(`账号服务删除失败：${error.message}`);
    logger.warn("账号服务删除账号失败", {
      email: emailAddress,
      reason,
      error: error.message
    });
  }

  if (errors.length) {
    throw new Error(errors.join("；"));
  }

  if (record.id) {
    await deleteRegisterHistory(record.id);
  } else {
    logger.info("账号没有本地历史记录 ID，跳过本地历史删除", {
      email: emailAddress,
      reason
    });
  }
  logger.info("账号删除处理完成", {
    email: emailAddress,
    reason
  });
}
