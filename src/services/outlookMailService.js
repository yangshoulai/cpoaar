import { joinUrl } from "../core/http.js";
import { createLogger } from "../core/logger.js";
import { clearOutlookMailAuthCache, loadOutlookMailAuthCache, saveOutlookMailAuthCache } from "../core/storage.js";

const logger = createLogger("outlook-mail");
const OPENAI_SENDER_KEYWORD = "openai.com";
const SUBJECT_KEYWORDS = ["ChatGPT", "OpenAI"];
const DEFAULT_AUTH_CACHE_TTL_MINUTES = 120;
const AUTH_CACHE_VERSION = 1;

let sharedAuthCache = null;
const initializingByCacheKey = new Map();

export class OutlookMailEmailService {
  constructor(config, httpClient) {
    this.config = config;
    this.http = httpClient;
    this.csrfToken = "";
    this.initialized = false;
  }

  async initialize() {
    const cacheKey = buildAuthCacheKey(this.config);
    if (this.initialized && isAuthCacheValid({
      version: AUTH_CACHE_VERSION,
      cacheKey,
      csrfToken: this.csrfToken,
      expiresAt: this.authExpiresAt
    })) {
      return;
    }

    if (await this._restoreAuthCache(cacheKey)) {
      return;
    }

    if (initializingByCacheKey.has(cacheKey)) {
      await initializingByCacheKey.get(cacheKey);
      if (await this._restoreAuthCache(cacheKey)) {
        return;
      }
    }

    const initializing = this._loginAndCache(cacheKey);
    initializingByCacheKey.set(cacheKey, initializing);
    try {
      await initializing;
    } finally {
      initializingByCacheKey.delete(cacheKey);
    }
  }

  async clearAuthentication() {
    await clearAuthenticationForConfig(this.config);
    this.csrfToken = "";
    this.initialized = false;
    this.authExpiresAt = "";
  }

  async _restoreAuthCache(cacheKey) {
    const memoryCache = sharedAuthCache;
    if (isAuthCacheValid(memoryCache, cacheKey)) {
      this._applyAuthCache(memoryCache);
      logger.info("复用 OutlookMail 认证缓存", {
        source: "memory",
        expiresAt: memoryCache.expiresAt
      });
      return true;
    }

    const persistedCache = await loadOutlookMailAuthCache();
    if (isAuthCacheValid(persistedCache, cacheKey)) {
      sharedAuthCache = persistedCache;
      this._applyAuthCache(persistedCache);
      logger.info("复用 OutlookMail 认证缓存", {
        source: "storage",
        expiresAt: persistedCache.expiresAt
      });
      return true;
    }
    return false;
  }

  _applyAuthCache(cache) {
    this.csrfToken = cache.csrfToken || "";
    this.initialized = true;
    this.authExpiresAt = cache.expiresAt || "";
    this.authCacheKey = cache.cacheKey || "";
  }

  async _loginAndCache(cacheKey) {
    logger.info("初始化 OutlookMail 会话");
    const loginPayload = await this.http.post(joinUrl(this.config.baseUrl, "/api/extension/login"), {
      password: this.config.adminPassword,
      next: "/#settings"
    }, {
      credentials: "include"
    });
    if (!loginPayload?.success || !loginPayload.launch_url) {
      throw new Error(`OutlookMail 登录失败: ${JSON.stringify(loginPayload)}`);
    }
    await this.http.get(joinUrl(this.config.baseUrl, loginPayload.launch_url), {
      responseType: "text",
      credentials: "include"
    });
    const csrfPayload = await this.http.get(joinUrl(this.config.baseUrl, "/api/csrf-token"), {
      credentials: "include"
    });
    this.csrfToken = csrfPayload?.csrf_token || "";
    this.initialized = true;
    this.authCacheKey = cacheKey;
    this.authExpiresAt = new Date(Date.now() + getAuthCacheTtlMs(this.config)).toISOString();
    sharedAuthCache = {
      version: AUTH_CACHE_VERSION,
      cacheKey,
      csrfToken: this.csrfToken,
      cachedAt: new Date().toISOString(),
      expiresAt: this.authExpiresAt,
      baseUrl: normalizeBaseUrl(this.config.baseUrl)
    };
    await saveOutlookMailAuthCache(sharedAuthCache);
    logger.info("OutlookMail 初始化完成");
  }

  async generateEmailAddress() {
    await this.initialize();
    if (this.config.useTempEmail) {
      return this._generateTempEmail();
    }
    return this._allocateOutlookAccount();
  }

  async listGroups() {
    await this.initialize();
    const payload = await this._request("/api/groups");
    if (!payload?.success || !Array.isArray(payload.groups)) {
      throw new Error(`OutlookMail 分组列表响应异常: ${JSON.stringify(payload)}`);
    }
    return payload.groups;
  }

  async findOutlookAccountByEmail(emailAddress) {
    await this.initialize();
    const normalizedEmail = normalizeEmailAddress(emailAddress);
    if (!normalizedEmail) {
      return null;
    }
    const searchPayload = await this._request("/api/accounts/search", {
      query: { q: normalizedEmail }
    });
    if (!searchPayload?.success || !Array.isArray(searchPayload.accounts)) {
      throw new Error(`Outlook 邮箱账号搜索响应异常: ${JSON.stringify(searchPayload)}`);
    }
    const matched = searchPayload.accounts.find((account) => (
      normalizeEmailAddress(account.email) === normalizedEmail
    )) || searchPayload.accounts[0];
    if (!matched?.id) {
      logger.warn("Outlook 邮箱账号搜索无结果", { email: normalizedEmail });
      return null;
    }
    const detailPayload = await this._request(`/api/accounts/${encodeURIComponent(matched.id)}`);
    const account = detailPayload?.account || matched;
    if (!account?.email) {
      throw new Error(`Outlook 邮箱账号详情缺少 email: ${JSON.stringify(detailPayload)}`);
    }
    logger.info("Outlook 邮箱账号搜索成功", {
      email: account.email,
      accountId: account.id
    });
    return buildOutlookEmailAccount(account);
  }

  async searchFirstEmail(emailAccount, sentAfter, options = {}) {
    await this.initialize();
    if (emailAccount.attributes?.mode === "temp") {
      return this._searchTempEmail(emailAccount, sentAfter, options);
    }
    return this._searchOutlookEmail(emailAccount, sentAfter, options);
  }

  async callback(emailAccount, isEmailUsed) {
    if (!isEmailUsed || emailAccount.attributes?.mode !== "outlook") {
      return;
    }
    await this.initialize();
    const resolved = await this._resolveOutlookAccount(emailAccount);
    const account = resolved.account;
    const accountId = resolved.accountId;
    if (!accountId) {
      logger.warn("Outlook 邮箱缺少 accountId，跳过分组移动");
      return;
    }
    logger.info("移动 Outlook 邮箱到已注册分组", {
      email: emailAccount.emailAddress,
      accountId
    });
    await this._request(`/api/accounts/${encodeURIComponent(accountId)}`, {
      method: "PUT",
      body: {
        email: account.email || emailAccount.emailAddress,
        client_id: account.client_id || account.clientId || "",
        refresh_token: account.refresh_token || account.refreshToken || "",
        group_id: this.config.outlook.registeredGroupId
      }
    });
  }

  async deleteAccount(emailRecord) {
    const emailAccount = emailRecord?.emailAccount || emailRecord;
    if (this.config.outlook.moveEmailOnReauthorizeDelete !== true) {
      logger.info("邮箱删除回调未启用移动邮箱，跳过远程分组移动", {
        email: emailRecord?.emailAddress || emailAccount?.emailAddress || ""
      });
      return;
    }
    await this.initialize();
    const mode = emailRecord?.emailMode || emailAccount?.attributes?.mode || "";
    if (mode === "temp") {
      logger.info("临时邮箱没有账号分组可移动，跳过邮箱删除回调", {
        email: emailRecord?.emailAddress || emailAccount?.emailAddress || ""
      });
      return;
    }

    const resolved = await this._resolveOutlookAccount(emailAccount, emailRecord);
    const account = resolved.account;
    const accountId = resolved.accountId;
    if (!accountId) {
      throw new Error("Outlook 邮箱删除回调失败：缺少 accountId，无法移动到已删除分组");
    }
    if (!this.config.outlook.deletedGroupId) {
      throw new Error("Outlook 邮箱删除回调失败：未配置已删除分组");
    }

    logger.info("移动 Outlook 邮箱到已删除分组", {
      email: account.email || emailRecord?.emailAddress || emailAccount?.emailAddress || "",
      accountId,
      deletedGroupId: this.config.outlook.deletedGroupId
    });
    await this._request(`/api/accounts/${encodeURIComponent(accountId)}`, {
      method: "PUT",
      body: {
        email: account.email || emailRecord?.emailAddress || emailAccount?.emailAddress || "",
        client_id: account.client_id || account.clientId || "",
        refresh_token: account.refresh_token || account.refreshToken || "",
        group_id: this.config.outlook.deletedGroupId
      }
    });
  }

  async _resolveOutlookAccount(emailAccount, emailRecord = {}) {
    const existingAccount = emailAccount?.attributes?.account || emailRecord?.outlookAccount || {};
    const existingAccountId = existingAccount.id
      || emailAccount?.attributes?.accountId
      || emailRecord?.outlookAccountId
      || "";
    if (existingAccountId) {
      return {
        account: existingAccount,
        accountId: String(existingAccountId)
      };
    }

    const emailAddress = emailRecord?.emailAddress || emailAccount?.emailAddress || existingAccount.email || "";
    const resolvedEmailAccount = await this.findOutlookAccountByEmail(emailAddress);
    if (!resolvedEmailAccount) {
      return {
        account: existingAccount,
        accountId: ""
      };
    }
    if (emailAccount?.attributes) {
      emailAccount.attributes.accountId = resolvedEmailAccount.attributes.accountId;
      emailAccount.attributes.account = resolvedEmailAccount.attributes.account;
    }
    if (emailRecord) {
      emailRecord.outlookAccountId = resolvedEmailAccount.attributes.accountId;
      emailRecord.outlookAccount = resolvedEmailAccount.attributes.account;
    }
    return {
      account: resolvedEmailAccount.attributes.account,
      accountId: resolvedEmailAccount.attributes.accountId
    };
  }

  async _generateTempEmail() {
    const temp = this.config.tempEmail;
    const payload = await this._request("/api/temp-emails/generate", {
      method: "POST",
      body: {
        provider: temp.provider,
        channel_id: temp.channelId,
        domain: temp.domain
      }
    });
    if (!payload?.success || !payload.email) {
      throw new Error(`临时邮箱生成失败: ${JSON.stringify(payload)}`);
    }
    logger.info("临时邮箱生成成功", { email: payload.email });
    return {
      emailAddress: payload.email,
      attributes: {
        mode: "temp",
        provider: temp.provider,
        raw: payload
      }
    };
  }

  async _allocateOutlookAccount() {
    const groupId = this.config.outlook.poolGroupId;
    const listPayload = await this._request("/api/accounts", {
      query: { group_id: groupId }
    });
    const first = listPayload?.accounts?.[0];
    if (!first?.id) {
      throw new Error(`Outlook 邮箱池为空: group_id=${groupId}`);
    }
    const detailPayload = await this._request(`/api/accounts/${encodeURIComponent(first.id)}`);
    const account = detailPayload?.account || first;
    if (!account.email) {
      throw new Error(`Outlook 邮箱详情缺少 email: ${JSON.stringify(detailPayload)}`);
    }
    logger.info("Outlook 邮箱分配成功", {
      email: account.email,
      accountId: account.id
    });
    return buildOutlookEmailAccount(account);
  }

  async _searchTempEmail(emailAccount, sentAfter, options = {}) {
    const listPayload = await this._request(`/api/temp-emails/${encodeURIComponent(emailAccount.emailAddress)}/messages`, {
      signal: options.signal
    });
    const messages = listPayload?.emails || [];
    const matched = findCandidateMessage(messages, sentAfter);
    if (!matched) {
      return null;
    }
    const detailPayload = await this._request(`/api/temp-emails/${encodeURIComponent(emailAccount.emailAddress)}/messages/${encodeURIComponent(matched.id)}`, {
      signal: options.signal
    });
    return buildEmailMessage(emailAccount.emailAddress, detailPayload?.email || matched);
  }

  async _searchOutlookEmail(emailAccount, sentAfter, options = {}) {
    const listPayload = await this._request(`/api/emails/${encodeURIComponent(emailAccount.emailAddress)}`, {
      query: { folder: "all" },
      signal: options.signal
    });
    const messages = listPayload?.emails || [];
    const matched = findCandidateMessage(messages, sentAfter);
    if (!matched) {
      return null;
    }
    const detailPayload = await this._request(`/api/email/${encodeURIComponent(emailAccount.emailAddress)}/${encodeURIComponent(matched.id)}`, {
      signal: options.signal
    });
    return buildEmailMessage(emailAccount.emailAddress, detailPayload?.email || matched);
  }

  async _request(path, options = {}) {
    const headers = {
      ...(options.headers || {})
    };
    if (this.csrfToken) {
      headers["X-CSRFToken"] = this.csrfToken;
    }
    const url = joinUrl(this.config.baseUrl, path);
    try {
      return await this.http.request(url, {
        ...options,
        headers,
        credentials: options.credentials ?? "include"
      });
    } catch (error) {
      if ((error.status === 401 || error.status === 403) && options.retryOnAuthFailure !== false) {
        logger.warn("OutlookMail 请求认证失效，清除缓存后重新初始化", {
          status: error.status,
          path
        });
        await this.clearAuthentication();
        await this.initialize();
        return this._request(path, {
          ...options,
          retryOnAuthFailure: false
        });
      }
      throw error;
    }
  }
}

export async function clearAuthenticationForConfig(config = {}) {
  sharedAuthCache = null;
  await clearOutlookMailAuthCache();
  await clearCookiesForBaseUrl(config.baseUrl);
  logger.info("OutlookMail 认证信息已清除", {
    baseUrl: normalizeBaseUrl(config.baseUrl)
  });
}

function buildAuthCacheKey(config = {}) {
  return [
    AUTH_CACHE_VERSION,
    normalizeBaseUrl(config.baseUrl),
    hashText(config.adminPassword || "")
  ].join("|");
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function getAuthCacheTtlMs(config = {}) {
  const minutes = Number(config.authCacheTtlMinutes || DEFAULT_AUTH_CACHE_TTL_MINUTES);
  return Math.max(1, minutes) * 60 * 1000;
}

function hashText(value) {
  let hash = 5381;
  for (const char of String(value || "")) {
    hash = ((hash << 5) + hash) ^ char.charCodeAt(0);
  }
  return (hash >>> 0).toString(16);
}

function isAuthCacheValid(cache, expectedCacheKey = "") {
  if (!cache?.csrfToken || !cache.expiresAt) {
    return false;
  }
  if (cache.version !== AUTH_CACHE_VERSION) {
    return false;
  }
  if (expectedCacheKey && cache.cacheKey !== expectedCacheKey) {
    return false;
  }
  return Date.now() < new Date(cache.expiresAt).getTime();
}

async function clearCookiesForBaseUrl(baseUrl) {
  const host = getHost(baseUrl);
  if (!host || !chrome.cookies?.getAll) {
    return;
  }
  const cookies = await chrome.cookies.getAll({ domain: host }).catch(() => []);
  for (const cookie of cookies) {
    const url = buildCookieUrl(cookie);
    await chrome.cookies.remove({
      url,
      name: cookie.name,
      storeId: cookie.storeId
    }).catch(() => {});
  }
}

function getHost(baseUrl) {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "";
  }
}

function buildCookieUrl(cookie) {
  const protocol = cookie.secure ? "https:" : "http:";
  const domain = cookie.domain.replace(/^\./, "");
  return `${protocol}//${domain}${cookie.path || "/"}`;
}

function findCandidateMessage(messages, sentAfter) {
  const sentAfterTime = sentAfter ? new Date(sentAfter).getTime() : 0;
  return [...messages]
    .filter((message) => isOpenAiMessage(message))
    .filter((message) => parseMessageTime(message) >= sentAfterTime)
    .sort((left, right) => parseMessageTime(right) - parseMessageTime(left))[0] || null;
}

function isOpenAiMessage(message) {
  const sender = String(message.from || "").toLowerCase();
  const subject = String(message.subject || "");
  return sender.includes(OPENAI_SENDER_KEYWORD)
    && SUBJECT_KEYWORDS.some((keyword) => subject.includes(keyword));
}

function buildOutlookEmailAccount(account) {
  return {
    emailAddress: account.email,
    attributes: {
      mode: "outlook",
      accountId: String(account.id),
      account
    }
  };
}

function normalizeEmailAddress(value) {
  return String(value || "").trim().toLowerCase();
}

function buildEmailMessage(emailAddress, rawMessage) {
  const body = rawMessage.body || rawMessage.body_preview || "";
  const code = extractSixDigitCode(htmlToText(body) || rawMessage.subject || "");
  return {
    emailAddress,
    sender: rawMessage.from || "",
    subject: rawMessage.subject || "",
    sentAt: new Date(parseMessageTime(rawMessage)).toISOString(),
    body,
    bodyType: rawMessage.body_type || (rawMessage.has_html ? "html" : "text"),
    messageId: String(rawMessage.id || ""),
    verificationCode: code,
    attributes: rawMessage
  };
}

function parseMessageTime(message) {
  if (typeof message.timestamp === "number") {
    return message.timestamp * 1000;
  }
  if (typeof message.date === "number") {
    return message.date * 1000;
  }
  const raw = message.date || message.created_at || "";
  const time = new Date(raw).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function htmlToText(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSixDigitCode(text) {
  const match = String(text || "").match(/(?<!\d)\d{6}(?!\d)/);
  return match ? match[0] : "";
}
