import { joinUrl } from "../core/http.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("outlook-mail");
const OPENAI_SENDER_KEYWORD = "openai.com";
const SUBJECT_KEYWORDS = ["ChatGPT", "OpenAI"];

export class OutlookMailEmailService {
  constructor(config, httpClient) {
    this.config = config;
    this.http = httpClient;
    this.csrfToken = "";
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) {
      return;
    }
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
    const account = emailAccount.attributes.account || {};
    const accountId = account.id || emailAccount.attributes.accountId;
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

    const account = emailAccount?.attributes?.account || emailRecord?.outlookAccount || {};
    const accountId = account.id || emailAccount?.attributes?.accountId || emailRecord?.outlookAccountId || "";
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
    return {
      emailAddress: account.email,
      attributes: {
        mode: "outlook",
        accountId: String(account.id),
        account
      }
    };
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
    return this.http.request(url, {
      ...options,
      headers,
      credentials: options.credentials ?? "include"
    });
  }
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
