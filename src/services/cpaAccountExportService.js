import { joinUrl } from "../core/http.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("cpa");

export class CpaAccountExportService {
  constructor(config, httpClient) {
    this.config = config;
    this.http = httpClient;
  }

  async getOauthUrl() {
    const url = joinUrl(this.config.baseUrl, "codex-auth-url");
    logger.info("获取 CPA Codex OAuth 链接", { url });
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
      state: payload.state || "",
      attributes: payload
    };
  }

  async submitRedirectUrl(redirectUrl) {
    const url = joinUrl(this.config.baseUrl, "oauth-callback");
    logger.info("提交 CPA OAuth 回调地址", { url, redirectUrl });
    const payload = await this.http.post(url, {
      provider: "codex",
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

  _headers() {
    return {
      "X-Management-Key": this.config.secretKey || ""
    };
  }
}
