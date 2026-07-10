import { joinUrl } from "../core/http.js";
import { createLogger } from "../core/logger.js";
import { ACCOUNT_TYPES, normalizeAccountType } from "../core/runModes.js";

const logger = createLogger("cpa");

export class CpaAccountService {
  constructor(config, httpClient, options = {}) {
    this.config = config;
    this.http = httpClient;
    this.accountType = normalizeAccountType(options.accountType);
  }

  async getOauthUrl(options = {}) {
    const accountType = this._resolveAccountType(options);
    const url = accountType === ACCOUNT_TYPES.xai
      ? joinUrl(this._xaiBaseUrl(), "xai-auth-url")
      : joinUrl(this.config.baseUrl, "codex-auth-url");
    logger.info(accountType === ACCOUNT_TYPES.xai ? "获取 CPA xAI OAuth 链接" : "获取 CPA Codex OAuth 链接", { url });
    const payload = await this.http.get(url, {
      query: { is_webui: "true" },
      headers: this._headers(),
      credentials: "omit"
    });
    if (!payload || payload.status !== "ok" || !payload.url) {
      throw new Error(`CPA OAuth 链接响应异常: ${JSON.stringify(payload)}`);
    }
    return {
      url: payload.url,
      state: payload.state || getUrlQueryParam(payload.url, "state"),
      attributes: payload
    };
  }

  async submitRedirectUrl(redirectUrl, options = {}) {
    const accountType = this._resolveAccountType(options);
    const url = accountType === ACCOUNT_TYPES.xai
      ? joinUrl(this._xaiBaseUrl(), "oauth-callback")
      : joinUrl(this.config.baseUrl, "oauth-callback");
    const provider = accountType === ACCOUNT_TYPES.xai ? "xai" : "codex";
    logger.info("提交 CPA OAuth 回调地址", { url, provider, redirectUrl });
    const payload = await this.http.post(url, {
      provider,
      redirect_url: redirectUrl
    }, {
      headers: this._headers(),
      credentials: "omit"
    });
    return {
      success: payload?.status === "ok",
      status: payload?.status || "unknown",
      error: payload?.error || "",
      attributes: payload || {}
    };
  }

  async deleteAccount(record) {
    const emailAddress = record?.emailAddress || record?.emailAccount?.emailAddress || "";
    if (!emailAddress) {
      throw new Error("CPA 账号删除失败：缺少邮箱地址");
    }
    const fileName = buildCodexAuthFileName(emailAddress);
    const url = joinUrl(this.config.baseUrl, "auth-files");
    logger.info("删除 CPA Codex 认证文件", {
      url,
      email: emailAddress,
      fileName
    });
    const payload = await this.http.request(url, {
      method: "DELETE",
      query: { name: fileName },
      headers: this._headers(),
      credentials: "omit"
    });
    const success = payload == null
      || payload?.success === true
      || payload?.status === "ok";
    return {
      success,
      status: payload?.status || (success ? "ok" : "unknown"),
      error: payload?.error || payload?.message || "",
      fileName,
      attributes: payload || {}
    };
  }

  _headers() {
    return {
      "X-Management-Key": this.config.secretKey || ""
    };
  }

  _resolveAccountType(options = {}) {
    return normalizeAccountType(options.accountType || this.accountType);
  }

  _xaiBaseUrl() {
    return this.config.xaiBaseUrl || this.config.baseUrl;
  }
}

function buildCodexAuthFileName(emailAddress) {
  return `codex-${String(emailAddress || "").trim()}-free.json`;
}

function getUrlQueryParam(value, key) {
  try {
    return new URL(value).searchParams.get(key) || "";
  } catch {
    return "";
  }
}
