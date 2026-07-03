import { createLogger } from "../core/logger.js";

const DB_NAME = "auto-register";
const DB_VERSION = 1;
const STORE_NAME = "sms_activations";
const logger = createLogger("activation-store");

export class SmsActivationStore {
  async upsert(record) {
    const db = await openDb();
    const now = new Date().toISOString();
    const existing = await getRecord(db, [record.provider, String(record.activationId)]);
    const nextRecord = {
      ...(existing || {}),
      ...record,
      activationId: String(record.activationId),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      verificationCodeReceivedCount: existing?.verificationCodeReceivedCount || 0,
      verificationCodes: existing?.verificationCodes || [],
      isAvailable: record.isAvailable ?? true
    };
    await replaceAllRecords(db, nextRecord);
    logger.info("最近短信号码缓存已更新", {
      provider: nextRecord.provider,
      activationId: nextRecord.activationId,
      mobile: nextRecord.mobileNumber
    });
  }

  async getLatestActivation() {
    const db = await openDb();
    const records = await getAllRecords(db);
    const latest = records.sort((left, right) => latestTime(right) - latestTime(left))[0] || null;
    if (latest && records.length > 1) {
      await replaceAllRecords(db, latest);
      logger.info("本地短信号码缓存已压缩为最近一条", {
        provider: latest.provider,
        activationId: latest.activationId,
        removedCount: records.length - 1
      });
    }
    return latest;
  }

  async getReusableActivationStatus({
    provider,
    serviceCode,
    excludedActivationIds = [],
    now = new Date(),
    reuseMinIntervalSeconds,
    minRemainingSeconds
  }) {
    const record = await this.getLatestActivation();
    if (!record) {
      return null;
    }

    const reason = getNotReusableReason(record, {
      provider,
      serviceCode,
      excludedActivationIds,
      now,
      reuseMinIntervalSeconds,
      minRemainingSeconds
    });
    if (reason) {
      logger.info("最近短信号码不可复用", {
        provider,
        cachedProvider: record.provider,
        activationId: record.activationId,
        mobile: record.mobileNumber,
        reason
      });
      return null;
    }

    const reusableAt = getReusableAt(record, reuseMinIntervalSeconds);
    return {
      record,
      reusableAt: reusableAt.toISOString(),
      waitSeconds: Math.max(0, (reusableAt.getTime() - now.getTime()) / 1000)
    };
  }

  async recordVerificationCode(provider, activationId, entry) {
    const db = await openDb();
    const record = await getRecord(db, [provider, String(activationId)]);
    if (!record) {
      return;
    }
    const receivedAt = entry.receivedAt || new Date().toISOString();
    const codes = record.verificationCodes || [];
    const nextCode = {
      code: entry.code,
      text: entry.text || "",
      receivedAt,
      raw: entry.raw || {}
    };
    const duplicated = codes.some((item) => (
      String(item.code || "") === String(nextCode.code || "") &&
      String(item.receivedAt || "") === String(nextCode.receivedAt || "")
    ));
    const nextCodes = duplicated ? codes : [...codes, nextCode];
    await putRecord(db, {
      ...record,
      verificationCodes: nextCodes,
      verificationCodeReceivedCount: duplicated
        ? Number(record.verificationCodeReceivedCount || 0)
        : Number(record.verificationCodeReceivedCount || 0) + 1,
      lastVerificationCodeReceivedAt: receivedAt,
      updatedAt: new Date().toISOString()
    });
  }

  async listVerificationCodes(provider, activationId) {
    const db = await openDb();
    const record = await getRecord(db, [provider, String(activationId)]);
    return Array.isArray(record?.verificationCodes) ? [...record.verificationCodes] : [];
  }

  async markVerificationCodeUsable(provider, activationId) {
    const db = await openDb();
    const key = [provider, String(activationId)];
    const record = await getRecord(db, key);
    if (!record) {
      return;
    }
    await putRecord(db, {
      ...record,
      lastVerificationCodeUsableAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  async markUnavailable(provider, activationId, error) {
    const db = await openDb();
    const key = [provider, String(activationId)];
    const record = await getRecord(db, key);
    if (!record) {
      return;
    }
    await putRecord(db, {
      ...record,
      isAvailable: false,
      lastError: error,
      lastFailedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }
}

function getNotReusableReason(record, {
  provider,
  serviceCode,
  excludedActivationIds,
  now,
  reuseMinIntervalSeconds,
  minRemainingSeconds
}) {
  const excluded = new Set([...excludedActivationIds].map(String));
  if (record.provider !== provider) {
    return "provider_mismatch";
  }
  if (record.serviceCode !== serviceCode) {
    return "service_mismatch";
  }
  if (record.isAvailable === false) {
    return "unavailable";
  }
  if (record.canGetAnotherSms !== true) {
    return "cannot_get_another_sms";
  }
  if (excluded.has(String(record.activationId))) {
    return "excluded";
  }
  if (!record.lastVerificationCodeUsableAt) {
    return "no_usable_time";
  }

  const reusableAt = getReusableAt(record, reuseMinIntervalSeconds);
  const requiredEndTime = reusableAt.getTime() + Number(minRemainingSeconds || 0) * 1000;
  if (toTime(record.activationEndTime) <= requiredEndTime) {
    return "insufficient_remaining_time";
  }
  if (toTime(record.activationEndTime) <= now.getTime()) {
    return "expired";
  }
  return "";
}

function getReusableAt(record, reuseMinIntervalSeconds) {
  return new Date(toTime(record.lastVerificationCodeUsableAt) + Number(reuseMinIntervalSeconds || 0) * 1000);
}

function latestTime(record) {
  return toTime(record.updatedAt) || toTime(record.activationTime) || toTime(record.createdAt);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: ["provider", "activationId"]
        });
        store.createIndex("provider", "provider", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getRecord(db, key) {
  return requestToPromise(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key));
}

function putRecord(db, record) {
  return requestToPromise(db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(record));
}

async function replaceAllRecords(db, record) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    store.clear();
    store.put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function getAllRecords(db) {
  return requestToPromise(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll());
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function toTime(value) {
  if (!value) {
    return 0;
  }
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}
