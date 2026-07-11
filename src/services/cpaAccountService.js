import { joinUrl } from "../core/http.js";
import { createLogger } from "../core/logger.js";
import { ACCOUNT_TYPES, normalizeAccountType } from "../core/runModes.js";

const logger = createLogger("cpa");

const XAI_AUTH_FILE_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const XAI_AUTH_FILE_HEADERS = Object.freeze({
  "x-grok-client-version": "0.2.93",
  "x-xai-token-auth": "xai-grok-cli",
  "x-authenticateresponse": "authenticate-response",
  "x-grok-client-identifier": "grok-shell",
  "User-Agent": "grok-shell/0.2.93 (linux; x86_64)"
});
const XAI_AUTH_FILE_DOWNLOAD_MAX_ATTEMPTS = 30;
const XAI_AUTH_FILE_DOWNLOAD_RETRY_INTERVAL_MS = 2000;

export class CpaAccountService {
  constructor(config, httpClient, options = {}) {
    this.config = config;
    this.http = httpClient;
    this.accountType = normalizeAccountType(options.accountType);
  }

  async getOauthUrl(options = {}) {
    const accountType = this._resolveAccountType(options);
    const url = accountType === ACCOUNT_TYPES.xai
      ? joinUrl(this.config.baseUrl, "xai-auth-url")
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
      oauthFlow: accountType === ACCOUNT_TYPES.xai && isXAiDeviceOauthUrl(payload.url) ? "device" : "authorization_code",
      userCode: getUrlQueryParam(payload.url, "user_code"),
      attributes: payload
    };
  }

  async submitRedirectUrl(redirectUrl, options = {}) {
    const accountType = this._resolveAccountType(options);
    const url = joinUrl(this.config.baseUrl, "oauth-callback");
    const provider = accountType === ACCOUNT_TYPES.xai ? "xai" : "codex";
    logger.info("提交 CPA OAuth 回调地址", { url, provider, redirectUrl });
    const payload = await this.http.post(url, {
      provider,
      redirect_url: redirectUrl
    }, {
      headers: this._headers(),
      credentials: "omit"
    });
    const result = {
      success: payload?.status === "ok",
      status: payload?.status || "unknown",
      error: payload?.error || "",
      attributes: payload || {}
    };
    if (accountType !== ACCOUNT_TYPES.xai || !result.success) {
      return result;
    }

    try {
      const patchResult = await this.patchXAiAuthFile({
        emailAddress: options.emailAddress || options.email || ""
      });
      return {
        ...result,
        xaiAuthFilePatchResult: patchResult
      };
    } catch (error) {
      logger.warn("修补 CPA xAI 认证文件失败", {
        error: formatServiceError(error),
        email: options.emailAddress || options.email || ""
      });
      return {
        ...result,
        success: false,
        status: "xai_auth_file_patch_failed",
        error: `CPA xAI 认证文件修补失败：${formatServiceError(error)}`,
        xaiAuthFilePatchResult: {
          success: false,
          status: "failed",
          error: formatServiceError(error)
        }
      };
    }
  }

  async patchXAiAuthFile({ emailAddress } = {}) {
    const fileName = buildXAiAuthFileName(emailAddress);
    const downloadUrl = joinUrl(this.config.baseUrl, "auth-files/download");
    logger.info("下载 CPA xAI 认证文件", {
      url: downloadUrl,
      fileName
    });
    const authFile = await this.downloadAuthFile(downloadUrl, fileName);
    const patchedAuthFile = patchXAiAuthFileContent(authFile);
    const uploadUrl = joinUrl(this.config.baseUrl, "auth-files");
    logger.info("上传 CPA xAI 认证文件", {
      url: uploadUrl,
      fileName,
      baseUrl: patchedAuthFile.base_url,
      headerKeys: Object.keys(patchedAuthFile.headers || {})
    });
    const uploadPayload = await this.uploadAuthFile(uploadUrl, fileName, patchedAuthFile);
    const success = uploadPayload == null
      || uploadPayload?.success === true
      || uploadPayload?.status === "ok";
    if (!success) {
      throw new Error(uploadPayload?.error || uploadPayload?.message || `上传响应异常: ${JSON.stringify(uploadPayload)}`);
    }
    return {
      success: true,
      status: uploadPayload?.status || "ok",
      fileName,
      baseUrl: patchedAuthFile.base_url,
      headerKeys: Object.keys(patchedAuthFile.headers || {}),
      attributes: uploadPayload || {}
    };
  }

  async downloadAuthFile(url, fileName) {
    for (let attempt = 1; attempt <= XAI_AUTH_FILE_DOWNLOAD_MAX_ATTEMPTS; attempt += 1) {
      try {
        logger.info("查询 CPA xAI 认证文件", {
          fileName,
          attempt,
          maxAttempts: XAI_AUTH_FILE_DOWNLOAD_MAX_ATTEMPTS
        });
        const text = await this.http.get(url, {
          query: { name: fileName },
          headers: this._bearerHeaders(),
          credentials: "omit",
          responseType: "text"
        });
        return parseRequiredJson(text, `CPA xAI 认证文件 ${fileName}`);
      } catch (error) {
        const shouldRetry = isHttpStatus(error, 404) && attempt < XAI_AUTH_FILE_DOWNLOAD_MAX_ATTEMPTS;
        if (!shouldRetry) {
          throw error;
        }
        logger.info("CPA xAI 认证文件暂未生成，等待重试", {
          fileName,
          attempt,
          maxAttempts: XAI_AUTH_FILE_DOWNLOAD_MAX_ATTEMPTS,
          retryIntervalMs: XAI_AUTH_FILE_DOWNLOAD_RETRY_INTERVAL_MS,
          status: error.status || 0,
          body: truncateText(error.body || "", 300)
        });
        await delay(XAI_AUTH_FILE_DOWNLOAD_RETRY_INTERVAL_MS);
      }
    }
    throw new Error(`CPA xAI 认证文件下载失败: ${fileName}`);
  }

  async uploadAuthFile(url, fileName, authFile) {
    const text = await this.http.post(url, authFile, {
      query: { name: fileName },
      headers: this._bearerHeaders(),
      credentials: "omit",
      responseType: "text"
    });
    return parseOptionalJson(text);
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

  _bearerHeaders() {
    return {
      Authorization: `Bearer ${this.config.secretKey || ""}`
    };
  }

  _resolveAccountType(options = {}) {
    return normalizeAccountType(options.accountType || this.accountType);
  }
}

function buildCodexAuthFileName(emailAddress) {
  return `codex-${String(emailAddress || "").trim()}-free.json`;
}

function buildXAiAuthFileName(emailAddress) {
  const normalizedEmailAddress = String(emailAddress || "").trim();
  if (!normalizedEmailAddress) {
    throw new Error("缺少 xAI 邮箱地址，无法定位 CPA 认证文件");
  }
  return `xai-${normalizedEmailAddress}.json`;
}

function patchXAiAuthFileContent(authFile) {
  if (!isPlainObject(authFile)) {
    throw new Error("CPA xAI 认证文件内容不是 JSON 对象");
  }
  return {
    ...authFile,
    base_url: XAI_AUTH_FILE_BASE_URL,
    headers: mergeXAiAuthHeaders(authFile.headers)
  };
}

function mergeXAiAuthHeaders(headers) {
  const reservedKeys = new Set(Object.keys(XAI_AUTH_FILE_HEADERS).map((key) => key.toLowerCase()));
  const normalizedHeaders = {};
  if (isPlainObject(headers)) {
    for (const [key, value] of Object.entries(headers)) {
      if (!reservedKeys.has(key.toLowerCase())) {
        normalizedHeaders[key] = value;
      }
    }
  }
  return {
    ...normalizedHeaders,
    ...XAI_AUTH_FILE_HEADERS
  };
}

function parseRequiredJson(text, label) {
  try {
    return JSON.parse(text || "");
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON: ${error.message}`);
  }
}

function parseOptionalJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return {
      status: "ok",
      raw: trimmed
    };
  }
}

function getUrlQueryParam(value, key) {
  try {
    return new URL(value).searchParams.get(key) || "";
  } catch {
    return "";
  }
}

function isXAiDeviceOauthUrl(value) {
  try {
    return new URL(value || "").pathname.startsWith("/oauth2/device");
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatServiceError(error) {
  const message = `${error.name || "Error"}: ${error.message || String(error)}`;
  if (error.url) {
    return `${message}；URL=${error.url}`;
  }
  return message;
}

function isHttpStatus(error, status) {
  return Number(error?.status || 0) === status;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateText(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}
