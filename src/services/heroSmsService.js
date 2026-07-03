import { appendQuery } from "../core/http.js";
import { createLogger } from "../core/logger.js";
import { sleep } from "../core/browser.js";

const logger = createLogger("hero-sms");

export class HeroSmsService {
  static provider = "hero_sms";
  static serviceCode = "dr";
  static cancelStatus = 8;
  static requestNewSmsStatus = 3;
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
    logger.info("HeroSMS 申请新手机号");
    return this._requestNewMobileNumber();
  }

  async getLatestVerificationCode(mobileNumber, sentAfter, options = {}) {
    const activationId = requireAttribute(mobileNumber, "activationId");
    const timeoutMs = Number(this.config.verificationCodeWaitTimeout || 125) * 1000;
    const deadline = Date.now() + timeoutMs;
    const knownCodes = await this.activationStore?.listVerificationCodes(this.constructor.provider, activationId) || [];
    let poll = 0;

    while (Date.now() <= deadline) {
      if (options.signal?.aborted) {
        logger.info("HeroSMS 验证码等待已取消", { activationId });
        return null;
      }
      poll += 1;
      logger.info("HeroSMS 查询验证码", {
        mobile: mobileNumber.mobileNumber,
        activationId,
        poll
      });
      const result = await this._queryLatestVerificationCode(activationId, options);
      if (result?.code) {
        if (isHistoricalVerificationCode(result, knownCodes, sentAfter)) {
          logger.info("HeroSMS 忽略历史验证码，继续等待新验证码", {
            mobile: mobileNumber.mobileNumber,
            activationId,
            code: result.code,
            receivedAt: result.receivedAt || "",
            sentAfter: sentAfter || ""
          });
          await sleep(Math.min(this.constructor.pollIntervalMs, Math.max(0, deadline - Date.now())), options.signal);
          continue;
        }
        await this.activationStore?.recordVerificationCode(this.constructor.provider, activationId, {
          code: result.code,
          text: result.text,
          receivedAt: result.receivedAt || new Date().toISOString(),
          raw: result.raw || {}
        });
        logger.info("HeroSMS 已获取验证码", { code: result.code });
        return result.code;
      }
      await sleep(Math.min(this.constructor.pollIntervalMs, Math.max(0, deadline - Date.now())), options.signal);
    }
    logger.warn("HeroSMS 等待验证码超时", { timeoutMs });
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
        logger.info("HeroSMS 验证码已成功使用，记录可复用冷却时间", { activationId });
        return;
      }
      logger.info("HeroSMS 取消未使用激活", { activationId });
      await this._setStatus(activationId, this.constructor.cancelStatus);
      await this.activationStore?.markUnavailable(this.constructor.provider, activationId, "流程取消或未收到验证码");
    } catch (error) {
      logger.warn("HeroSMS 回调失败，已抑制异常", {
        activationId,
        error: error.message
      });
    }
  }

  async _getReusableLocalMobileNumber(excludedActivationIds, signal = null) {
    const minRemainingSeconds = Number(this.config.verificationCodeWaitTimeout || 125);
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
      logger.info("HeroSMS 等待最近缓存号码可复用", {
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
      logger.info("HeroSMS 最近缓存号码复用成功", {
        mobile: record.mobileNumber,
        activationId: record.activationId
      });
      return mobileFromRecord(record, {
        reusedActivation: true,
        reusableActivationWaitSeconds: waitSeconds
      });
    } catch (error) {
      logger.warn("HeroSMS 最近缓存号码复用失败，标记不可用", {
        activationId: record.activationId,
        error: error.message
      });
      await this.activationStore.markUnavailable(this.constructor.provider, record.activationId, error.message);
    }
    return null;
  }

  async _requestNewMobileNumber() {
    const payload = await this._requestJson({
      action: "getNumberV2",
      service: this.constructor.serviceCode,
      country: this.config.countryId,
      maxPrice: this.config.maxPrice,
      api_key: this.config.apiKey
    });
    const record = {
      provider: this.constructor.provider,
      serviceCode: this.constructor.serviceCode,
      mobileNumber: requireResponseValue(payload, "phoneNumber"),
      activationId: String(requireResponseValue(payload, "activationId")),
      activationCost: payload.activationCost,
      currency: payload.currency,
      countryCode: payload.countryCode,
      countryPhoneCode: payload.countryPhoneCode,
      activationOperator: payload.activationOperator,
      activationTime: parseHeroDate(payload.activationTime).toISOString(),
      activationEndTime: parseHeroDate(payload.activationEndTime).toISOString(),
      canGetAnotherSms: Boolean(payload.canGetAnotherSms),
      raw: payload
    };
    await this.activationStore?.upsert(record);
    logger.info("HeroSMS 新手机号申请成功", {
      mobile: record.mobileNumber,
      activationId: record.activationId,
      cost: record.activationCost
    });
    return mobileFromRecord(record, { reusedActivation: false });
  }

  async _queryLatestVerificationCode(activationId, options = {}) {
    const payload = await this._requestJson({
      action: "getStatusV2",
      id: activationId,
      api_key: this.config.apiKey
    }, options);
    const smsCode = payload?.sms?.code;
    if (smsCode && String(smsCode).trim()) {
      return {
        code: String(smsCode).trim(),
        text: payload.sms.text || "",
        receivedAt: parseNullableDate(payload.sms.dateTime)?.toISOString(),
        raw: payload
      };
    }
    const callCode = payload?.call?.code;
    if (callCode && String(callCode).trim()) {
      return {
        code: String(callCode).trim(),
        text: payload.call.text || "",
        receivedAt: parseNullableDate(payload.call.dateTime)?.toISOString(),
        raw: payload
      };
    }
    return null;
  }

  async _setStatus(activationId, status) {
    return this._requestText({
      action: "setStatus",
      id: activationId,
      status,
      api_key: this.config.apiKey
    });
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
    throw new Error(`HeroSMS 响应缺少字段: ${name}`);
  }
  return value;
}

function parseHeroDate(value) {
  if (!value) {
    return new Date();
  }
  const text = String(value);
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) {
    return new Date(text);
  }
  return new Date(text.replace(" ", "T") + "+03:00");
}

function parseNullableDate(value) {
  if (!value || value === "0000-00-00 00:00:00") {
    return null;
  }
  const text = String(value);
  const isoText = text.replace(" ", "T");
  const date = /[zZ]|[+-]\d{2}:?\d{2}$/.test(isoText)
    ? new Date(isoText)
    : new Date(`${isoText}+03:00`);
  return Number.isNaN(date.getTime()) ? null : date;
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
