import { appendQuery } from "../core/http.js";
import { createLogger } from "../core/logger.js";
import { sleep } from "../core/browser.js";

const logger = createLogger("sms-bower");

export class SmsBowerService {
  static provider = "sms_bower";
  static serviceCode = "dr";
  static cancelStatus = 8;
  static requestNewSmsStatus = 3;
  static requestNewSmsSuccessStatuses = new Set(["ACCESS_READY", "ACCESS_RETRY_GET"]);
  static pollIntervalMs = 5000;
  static reusableWaitBufferSeconds = 1;

  constructor(config, httpClient, activationStore, activationStoreConfig) {
    this.config = config;
    this.http = httpClient;
    this.activationStore = activationStore;
    this.activationStoreConfig = activationStoreConfig || {};
  }

  async getMobileNumber({ excludedActivationIds = [], signal = null } = {}) {
    if (this.activationStore && this.activationStoreConfig.reusePhoneNumber) {
      const reusable = await this._getReusableLocalMobileNumber(excludedActivationIds, signal);
      if (reusable) {
        return reusable;
      }
    }
    if (signal?.aborted) {
      return null;
    }
    logger.info("SMSBower 申请新手机号");
    return this._requestNewMobileNumber();
  }

  async getPriceOptions(options = {}) {
    const payload = await this._requestJson({
      api_key: this.config.apiKey,
      action: "getPricesV3",
      service: this.constructor.serviceCode,
      country: this.config.countryId
    }, options);
    return normalizeBowerPrices(payload, {
      provider: this.constructor.provider,
      serviceCode: this.constructor.serviceCode,
      countryId: this.config.countryId
    });
  }

  async getLatestVerificationCode(mobileNumber, sentAfter, options = {}) {
    const activationId = requireAttribute(mobileNumber, "activationId");
    const timeoutMs = Number(this.config.verificationCodeWaitTimeout || 60) * 1000;
    const deadline = Date.now() + timeoutMs;
    const knownCodes = await this.activationStore?.listVerificationCodes(this.constructor.provider, activationId) || [];
    let poll = 0;

    while (Date.now() <= deadline) {
      if (options.signal?.aborted) {
        logger.info("SMSBower 验证码等待已取消", { activationId });
        return null;
      }
      poll += 1;
      logger.info("SMSBower 查询验证码", {
        mobile: mobileNumber.mobileNumber,
        activationId,
        poll
      });
      const result = await this._queryLatestVerificationCode(activationId, options);
      if (result?.code) {
        if (isHistoricalVerificationCode(result, knownCodes, sentAfter)) {
          logger.info("SMSBower 忽略历史验证码，继续等待新验证码", {
            mobile: mobileNumber.mobileNumber,
            activationId,
            code: result.code,
            sentAfter: sentAfter || ""
          });
          await sleep(Math.min(this.constructor.pollIntervalMs, Math.max(0, deadline - Date.now())), options.signal);
          continue;
        }
        await this.activationStore?.recordVerificationCode(this.constructor.provider, activationId, {
          code: result.code,
          text: result.text,
          receivedAt: new Date().toISOString(),
          raw: { raw: result.raw }
        });
        logger.info("SMSBower 已获取验证码", { code: result.code });
        return result.code;
      }
      await sleep(Math.min(this.constructor.pollIntervalMs, Math.max(0, deadline - Date.now())), options.signal);
    }
    logger.warn("SMSBower 等待验证码超时", { timeoutMs });
    return null;
  }

  async callback(mobileNumber, isVerificationCodeReceived) {
    const activationId = mobileNumber?.attributes?.activationId;
    if (!activationId) {
      return;
    }
    try {
      if (isVerificationCodeReceived) {
        await this.activationStore?.markVerificationCodeUsable(this.constructor.provider, activationId);
        logger.info("SMSBower 验证码已成功使用，记录可复用冷却时间", { activationId });
        return;
      }
      logger.info("SMSBower 取消未使用激活", { activationId });
      await this._setStatus(activationId, this.constructor.cancelStatus);
      await this.activationStore?.markUnavailable(this.constructor.provider, activationId, "流程取消或未收到验证码");
    } catch (error) {
      logger.warn("SMSBower 回调失败，已抑制异常", {
        activationId,
        error: error.message
      });
    }
  }

  async _getReusableLocalMobileNumber(excludedActivationIds, signal = null) {
    const minRemainingSeconds = Number(this.config.verificationCodeWaitTimeout || 60);
    let reusable = await this.activationStore.getReusableActivationStatus({
      provider: this.constructor.provider,
      serviceCode: this.constructor.serviceCode,
      excludedActivationIds,
      now: new Date(),
      reuseMinIntervalSeconds: Number(this.activationStoreConfig.reuseMinIntervalSeconds || 900),
      minRemainingSeconds
    });

    if (!reusable) {
      return null;
    }

    const waitSeconds = reusable.waitSeconds > 0
      ? reusable.waitSeconds + this.constructor.reusableWaitBufferSeconds
      : 0;
    if (waitSeconds > 0) {
      logger.info("SMSBower 等待最近缓存号码可复用", {
        mobile: reusable.record.mobileNumber,
        activationId: reusable.record.activationId,
        waitSeconds,
        reusableAt: reusable.reusableAt
      });
      await sleep(waitSeconds * 1000, signal);
      if (signal?.aborted) {
        return null;
      }
      reusable = await this.activationStore.getReusableActivationStatus({
        provider: this.constructor.provider,
        serviceCode: this.constructor.serviceCode,
        excludedActivationIds,
        now: new Date(),
        reuseMinIntervalSeconds: Number(this.activationStoreConfig.reuseMinIntervalSeconds || 900),
        minRemainingSeconds
      });
      if (!reusable || reusable.waitSeconds > 0) {
        return null;
      }
    }

    const record = reusable.record;
    try {
      await this._setStatus(record.activationId, this.constructor.requestNewSmsStatus);
      logger.info("SMSBower 最近缓存号码复用成功", {
        mobile: record.mobileNumber,
        activationId: record.activationId
      });
      return mobileFromRecord(record, {
        reusedActivation: true,
        reusableActivationWaitSeconds: waitSeconds
      });
    } catch (error) {
      logger.warn("SMSBower 最近缓存号码复用失败，标记不可用", {
        activationId: record.activationId,
        error: error.message
      });
      await this.activationStore.markUnavailable(this.constructor.provider, record.activationId, error.message);
    }
    return null;
  }

  async _requestNewMobileNumber() {
    const payload = await this._requestJson({
      api_key: this.config.apiKey,
      action: "getNumberV2",
      service: this.constructor.serviceCode,
      country: this.config.countryId,
      minPrice: this.config.minPrice,
      maxPrice: this.config.maxPrice
    });
    const activationTime = parseBowerDate(payload.activationTime);
    const activationEndTime = new Date(activationTime.getTime() + Number(this.config.activationValidSeconds || 1500) * 1000);
    const record = {
      provider: this.constructor.provider,
      serviceCode: this.constructor.serviceCode,
      mobileNumber: String(requireResponseValue(payload, "phoneNumber")),
      activationId: String(requireResponseValue(payload, "activationId")),
      activationCost: payload.activationCost,
      countryCode: payload.countryCode,
      activationOperator: payload.activationOperator,
      activationTime: activationTime.toISOString(),
      activationEndTime: activationEndTime.toISOString(),
      canGetAnotherSms: isEnabledFlag(payload.canGetAnotherSms),
      raw: payload
    };
    await this.activationStore?.upsert(record);
    logger.info("SMSBower 新手机号申请成功", {
      mobile: record.mobileNumber,
      activationId: record.activationId,
      cost: record.activationCost
    });
    return mobileFromRecord(record, { reusedActivation: false });
  }

  async _queryLatestVerificationCode(activationId, options = {}) {
    const text = await this._requestText({
      api_key: this.config.apiKey,
      action: "getStatus",
      id: activationId
    }, options);
    const match = String(text).match(/^STATUS_OK:\s*(.+)$/);
    if (!match) {
      return null;
    }
    return {
      code: match[1].trim().replace(/^['"]|['"]$/g, ""),
      text: String(text),
      raw: String(text)
    };
  }

  async _setStatus(activationId, status) {
    const text = await this._requestText({
      api_key: this.config.apiKey,
      action: "setStatus",
      status,
      id: activationId
    });
    if (Number(status) === this.constructor.requestNewSmsStatus && !this.constructor.requestNewSmsSuccessStatuses.has(text)) {
      throw new Error(`SMSBower 请求新验证码失败: ${text}`);
    }
    return text;
  }

  async _requestJson(query, options = {}) {
    return this.http.get(appendQuery(this.config.baseUrl, query), {
      signal: options.signal
    });
  }

  async _requestText(query, options = {}) {
    return this.http.get(appendQuery(this.config.baseUrl, query), {
      responseType: "text",
      signal: options.signal
    });
  }
}

function mobileFromRecord(record, extraAttributes) {
  return {
    mobileNumber: record.mobileNumber,
    attributes: {
      provider: record.provider,
      activationId: String(record.activationId),
      serviceCode: record.serviceCode,
      activationEndTime: record.activationEndTime,
      ...extraAttributes
    }
  };
}

function normalizeBowerPrices(payload, base) {
  const options = [];
  walkPricePayload(payload, (providerId, value) => {
    const price = Number(value?.price);
    if (!Number.isFinite(price)) {
      return;
    }
    options.push({
      ...base,
      providerId: String(value?.provider_id || providerId || ""),
      price,
      count: Number(value?.count || 0),
      raw: value
    });
  });
  return sortPriceOptions(options);
}

function walkPricePayload(value, onPrice, key = "") {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Object.hasOwn(value, "price") && Object.hasOwn(value, "count")) {
    onPrice(key, value);
    return;
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    walkPricePayload(childValue, onPrice, childKey);
  }
}

function sortPriceOptions(options) {
  return options.sort((left, right) => (
    left.price - right.price
    || right.count - left.count
    || String(left.providerId).localeCompare(String(right.providerId))
  ));
}

function requireAttribute(mobileNumber, name) {
  const value = mobileNumber?.attributes?.[name];
  if (value === undefined || value === null || value === "") {
    throw new Error(`手机号缺少属性: ${name}`);
  }
  return String(value);
}

function requireResponseValue(payload, name) {
  const value = payload?.[name];
  if (value === undefined || value === null || value === "") {
    throw new Error(`SMSBower 响应缺少字段: ${name}`);
  }
  return value;
}

function parseBowerDate(value) {
  if (!value) {
    return new Date();
  }
  const date = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function isEnabledFlag(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function isHistoricalVerificationCode(result, knownCodes, sentAfter) {
  const sentAfterTime = toValidTime(sentAfter);
  const receivedAtTime = toValidTime(result.receivedAt);
  if (sentAfterTime && receivedAtTime && receivedAtTime <= sentAfterTime) {
    return true;
  }
  return knownCodes.some((item) => {
    if (String(item.code || "") !== String(result.code || "")) {
      return false;
    }
    if (!receivedAtTime) {
      return true;
    }
    const knownReceivedAtTime = toValidTime(item.receivedAt);
    return sentAfterTime && (!knownReceivedAtTime || knownReceivedAtTime <= sentAfterTime);
  });
}

function toValidTime(value) {
  if (!value) {
    return 0;
  }
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}
