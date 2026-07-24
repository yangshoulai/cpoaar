import { sleep } from "../core/browser.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("xai-local-oauth");

const DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_AUTH_FILE_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const DEFAULT_EXPIRES_IN_SECONDS = 3600;
const DEFAULT_DEVICE_EXPIRES_IN_SECONDS = 600;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DISCOVERY_CACHE_TTL_MS = 30 * 60 * 1000;

export const XAI_LOCAL_AUTH_FILE_HEADERS = Object.freeze({
  "x-grok-client-version": "0.2.93",
  "x-xai-token-auth": "xai-grok-cli",
  "X-XAI-Token-Auth": "xai-grok-cli",
  "x-authenticateresponse": "authenticate-response",
  "x-grok-client-identifier": "grok-shell",
  "x-compaction-at": "400000",
  "User-Agent": "grok-shell/0.2.93 (linux; x86_64)"
});

export class XAiLocalOAuthError extends Error {
  constructor(message, { code = "", retryable = false, status = 0, body = "", url = "" } = {}) {
    super(message);
    this.name = "XAiLocalOAuthError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

export class XAiLocalOAuthService {
  constructor(httpClient) {
    this.http = httpClient;
    this.discoveryCache = null;
  }

  async discover({ signal = null } = {}) {
    if (this.discoveryCache && Date.now() - this.discoveryCache.cachedAt < DISCOVERY_CACHE_TTL_MS) {
      return this.discoveryCache.payload;
    }
    logger.info("查询 xAI OIDC Discovery", { url: DISCOVERY_URL });
    const payload = await this.http.get(DISCOVERY_URL, {
      headers: {
        Accept: "application/json, text/plain, */*"
      },
      credentials: "omit",
      cache: "no-store",
      signal
    });
    const deviceAuthorizationEndpoint = String(payload?.device_authorization_endpoint || "").trim();
    const tokenEndpoint = String(payload?.token_endpoint || "").trim();
    if (!deviceAuthorizationEndpoint || !tokenEndpoint) {
      throw new XAiLocalOAuthError(`xAI OIDC Discovery 缺少 endpoint: ${JSON.stringify(payload)}`, {
        code: "discovery_endpoint_missing"
      });
    }
    const normalized = {
      deviceAuthorizationEndpoint,
      tokenEndpoint,
      attributes: payload
    };
    this.discoveryCache = {
      cachedAt: Date.now(),
      payload: normalized
    };
    return normalized;
  }

  async startDeviceAuthorization({ signal = null } = {}) {
    const discovery = await this.discover({ signal });
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      scope: SCOPE
    }).toString();
    logger.info("申请 xAI 本地 OAuth device code", { url: discovery.deviceAuthorizationEndpoint });
    const payload = await this.http.post(discovery.deviceAuthorizationEndpoint, body, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Accept: "application/json, text/plain, */*"
      },
      credentials: "omit",
      signal
    });
    const deviceCode = String(payload?.device_code || "").trim();
    const userCode = String(payload?.user_code || "").trim();
    if (!deviceCode || !userCode) {
      throw new XAiLocalOAuthError(`xAI device authorization 响应缺少 device_code/user_code: ${JSON.stringify(payload)}`, {
        code: "device_authorization_payload_invalid"
      });
    }
    const verificationUrl = buildVerificationUrl(payload, userCode);
    const expiresIn = normalizePositiveInteger(payload?.expires_in, DEFAULT_DEVICE_EXPIRES_IN_SECONDS);
    const interval = normalizePositiveInteger(payload?.interval, DEFAULT_POLL_INTERVAL_SECONDS);
    return {
      deviceCode,
      userCode,
      verificationUrl,
      tokenEndpoint: discovery.tokenEndpoint,
      expiresIn,
      interval,
      startedAt: new Date().toISOString(),
      attributes: payload
    };
  }

  async pollToken(deviceAuthorization, { signal = null } = {}) {
    const deviceCode = String(deviceAuthorization?.deviceCode || deviceAuthorization?.device_code || "").trim();
    const tokenEndpoint = String(deviceAuthorization?.tokenEndpoint || deviceAuthorization?.token_endpoint || "").trim();
    if (!deviceCode || !tokenEndpoint) {
      throw new XAiLocalOAuthError("xAI 本地 OAuth token 轮询缺少 device_code 或 token_endpoint", {
        code: "token_polling_context_missing"
      });
    }
    const expiresIn = normalizePositiveInteger(deviceAuthorization?.expiresIn || deviceAuthorization?.expires_in, DEFAULT_DEVICE_EXPIRES_IN_SECONDS);
    let intervalSeconds = normalizePositiveInteger(deviceAuthorization?.interval, DEFAULT_POLL_INTERVAL_SECONDS);
    const deadline = Date.now() + expiresIn * 1000;
    let poll = 0;
    logger.info("开始轮询 xAI 本地 OAuth token", {
      tokenEndpoint,
      userCode: deviceAuthorization?.userCode || deviceAuthorization?.user_code || "",
      expiresIn,
      interval: intervalSeconds
    });

    while (Date.now() <= deadline) {
      throwIfAborted(signal);
      poll += 1;
      try {
        const payload = await this.requestDeviceToken(tokenEndpoint, deviceCode, { signal });
        validateTokenPayload(payload);
        logger.info("xAI 本地 OAuth token 已获取", {
          poll,
          tokenType: payload.token_type || "Bearer",
          expiresIn: payload.expires_in || ""
        });
        return payload;
      } catch (error) {
        throwIfAborted(signal);
        const tokenError = normalizeTokenPollingError(error);
        if (tokenError.code === "authorization_pending") {
          logger.info("xAI 本地 OAuth 授权尚未完成，继续等待", {
            poll,
            intervalSeconds
          });
          await sleep(Math.min(intervalSeconds * 1000, Math.max(deadline - Date.now(), 0)), signal);
          continue;
        }
        if (tokenError.code === "slow_down") {
          intervalSeconds += 1;
          logger.info("xAI 本地 OAuth token 轮询被要求降速", {
            poll,
            intervalSeconds
          });
          await sleep(Math.min(intervalSeconds * 1000, Math.max(deadline - Date.now(), 0)), signal);
          continue;
        }
        throw tokenError;
      }
    }
    throw new XAiLocalOAuthError("xAI 本地 OAuth token 轮询超时", {
      code: "token_polling_timeout",
      retryable: true,
      url: tokenEndpoint
    });
  }

  async requestDeviceToken(tokenEndpoint, deviceCode, { signal = null } = {}) {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      device_code: deviceCode,
      grant_type: DEVICE_GRANT_TYPE
    }).toString();
    return this.http.post(tokenEndpoint, body, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Accept: "application/json, text/plain, */*"
      },
      credentials: "omit",
      timeoutMs: 45000,
      signal
    });
  }

  buildAuthFile(tokenPayload, { emailAddress = "", tokenEndpoint = "" } = {}) {
    validateTokenPayload(tokenPayload);
    const now = new Date();
    const expiresIn = normalizePositiveInteger(tokenPayload.expires_in, DEFAULT_EXPIRES_IN_SECONDS);
    const expiredAt = new Date(now.getTime() + expiresIn * 1000);
    const idTokenClaims = parseJwtPayload(tokenPayload.id_token);
    const accessTokenClaims = parseJwtPayload(tokenPayload.access_token);
    const resolvedEmail = String(emailAddress || idTokenClaims.email || accessTokenClaims.email || "").trim();
    return {
      type: "xai",
      access_token: tokenPayload.access_token,
      refresh_token: tokenPayload.refresh_token,
      id_token: tokenPayload.id_token || "",
      token_type: tokenPayload.token_type || "Bearer",
      expires_in: expiresIn,
      expired: toSecondIsoString(expiredAt),
      last_refresh: toSecondIsoString(now),
      sub: String(idTokenClaims.sub || accessTokenClaims.sub || "").trim(),
      email: resolvedEmail,
      base_url: XAI_AUTH_FILE_BASE_URL,
      token_endpoint: String(tokenEndpoint || "").trim(),
      auth_kind: "oauth",
      headers: {
        ...XAI_LOCAL_AUTH_FILE_HEADERS
      }
    };
  }
}

function buildVerificationUrl(payload, userCode) {
  const direct = String(payload?.verification_uri_complete || "").trim();
  if (direct) {
    return direct;
  }
  const base = String(payload?.verification_uri || payload?.verification_url || "").trim();
  if (!base) {
    throw new XAiLocalOAuthError(`xAI device authorization 响应缺少 verification_uri: ${JSON.stringify(payload)}`, {
      code: "verification_url_missing"
    });
  }
  const url = new URL(base);
  if (!url.searchParams.get("user_code")) {
    url.searchParams.set("user_code", userCode);
  }
  return url.toString();
}

function validateTokenPayload(payload) {
  if (!payload?.access_token || !payload?.refresh_token) {
    throw new XAiLocalOAuthError(`xAI token 响应缺少 access_token/refresh_token: ${JSON.stringify(payload)}`, {
      code: "token_payload_invalid"
    });
  }
}

function normalizeTokenPollingError(error) {
  if (error instanceof XAiLocalOAuthError) {
    return error;
  }
  const payload = parseJsonObject(error?.body);
  const code = String(payload?.error || "").trim();
  const description = String(payload?.error_description || payload?.message || "").trim();
  if (code) {
    return new XAiLocalOAuthError(description || `xAI token polling 返回错误: ${code}`, {
      code,
      retryable: code === "invalid_grant" || code === "expired_token",
      status: Number(error?.status || 0),
      body: error?.body || "",
      url: error?.url || ""
    });
  }
  return new XAiLocalOAuthError(`${error?.name || "Error"}: ${error?.message || String(error)}`, {
    code: "token_polling_failed",
    retryable: Number(error?.status || 0) === 429 || Number(error?.status || 0) >= 500,
    status: Number(error?.status || 0),
    body: error?.body || "",
    url: error?.url || ""
  });
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJwtPayload(token) {
  const payload = String(token || "").split(".")[1] || "";
  if (!payload) {
    return {};
  }
  try {
    return JSON.parse(base64UrlDecode(payload));
  } catch {
    return {};
  }
}

function base64UrlDecode(value) {
  const base64 = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  if (typeof atob === "function") {
    return decodeURIComponent(Array.from(atob(padded), (char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""));
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(padded, "base64").toString("utf8");
  }
  throw new Error("当前环境不支持 base64 解码");
}

function normalizePositiveInteger(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function toSecondIsoString(date) {
  return new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString().replace(/\.000Z$/, "Z");
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error("流程已停止");
    error.name = "AbortError";
    throw error;
  }
}
