import { createLogger } from "../core/logger.js";

const logger = createLogger("manual-sms");

export class ManualSmsService {
  static provider = "manual";

  constructor(config = {}) {
    this.config = config || {};
  }

  async getMobileNumber({ signal = null } = {}) {
    if (signal?.aborted) {
      return null;
    }
    const mobileNumber = normalizeMobileNumber(this.config.mobileNumber);
    if (!mobileNumber) {
      throw new Error("手动短信模式未配置手机号");
    }
    logger.info("使用手动短信手机号", {
      mobile: mobileNumber
    });
    return {
      mobileNumber,
      attributes: {
        provider: this.constructor.provider,
        manual: true
      }
    };
  }

  async getLatestVerificationCode(mobileNumber, _sentAfter, { signal = null } = {}) {
    if (signal?.aborted) {
      return null;
    }
    const mobile = normalizeMobileNumber(mobileNumber?.mobileNumber || this.config.mobileNumber);
    const code = window.prompt(`请输入 ${mobile || "当前手机号"} 收到的短信验证码`);
    const normalizedCode = String(code || "").trim();
    if (!normalizedCode) {
      logger.warn("手动短信验证码为空或已取消");
      return null;
    }
    logger.info("已接收手动短信验证码");
    return normalizedCode;
  }

  async callback() {
    return;
  }
}

function normalizeMobileNumber(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  return text.startsWith("+") ? text : `+${text}`;
}
