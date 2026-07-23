import { RegisterNode, NodeResult } from "../core/flow.js";
import { sleep, waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";
import { ACCOUNT_TYPES } from "../core/runModes.js";
import { getPageTextTerms } from "../core/pageText.js";
import {
  clickVisibleButtonByText,
  findVisibleConsentAllowButton
} from "./xaiHelpers.js";

const logger = createLogger("node.xai-oauth");
const XAI_OAUTH_RATE_LIMIT_MAX_ATTEMPTS = 3;
const XAI_OAUTH_RATE_LIMIT_RETRY_DELAY_MS = 30000;

export class XAiRefreshOAuthAndLoginNode extends RegisterNode {
  static name = "xai_refresh_oauth_and_login";
  static statuses = {
    consent: "xai_oauth_consent_ready"
  };

  constructor() {
    super(XAiRefreshOAuthAndLoginNode.name, "刷新 xAI OAuth 并登录");
  }

  async execute(ctx) {
    for (let attempt = 1; attempt <= XAI_OAUTH_RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
      const result = await this.executeOauthAttempt(ctx, attempt);
      if (result.status !== "xai_oauth_rate_limited_retry") {
        return result;
      }
      if (attempt >= XAI_OAUTH_RATE_LIMIT_MAX_ATTEMPTS) {
        return NodeResult.fail("xai_oauth_rate_limited", "xAI OAuth device 页面被限流，重试后仍未恢复", result.data || {});
      }
      logger.warn("xAI OAuth device 页面被限流，等待后重新获取 OAuth 链接", {
        attempt,
        maxAttempts: XAI_OAUTH_RATE_LIMIT_MAX_ATTEMPTS,
        retryDelayMs: XAI_OAUTH_RATE_LIMIT_RETRY_DELAY_MS,
        currentUrl: result.data?.currentUrl || ""
      });
      await sleep(XAI_OAUTH_RATE_LIMIT_RETRY_DELAY_MS, ctx.signal);
      if (ctx.signal?.aborted) {
        return NodeResult.fail("stopped", "流程已停止");
      }
    }
    return NodeResult.fail("xai_oauth_rate_limited", "xAI OAuth device 页面被限流");
  }

  async executeOauthAttempt(ctx, attempt) {
    let oauth;
    try {
      oauth = await ctx.services.accountManagementService.getOauthUrl({
        accountType: ACCOUNT_TYPES.xai
      });
    } catch (error) {
      return NodeResult.fail("xai_oauth_request_failed", formatServiceError(error));
    }
    ctx.state.xaiOauthUrl = oauth;
    logger.info("访问 xAI OAuth 链接", {
      attempt,
      maxAttempts: XAI_OAUTH_RATE_LIMIT_MAX_ATTEMPTS,
      oauthFlow: oauth.oauthFlow || "",
      userCode: oauth.userCode || "",
      url: oauth.url
    });
    await ctx.tabs.navigate(oauth.url);

    const readyResult = await waitForAnyCondition([
      {
        name: "rate_limited_url",
        check: () => getRateLimitedOauthUrl(ctx)
      },
      {
        name: "consent_url",
        check: () => ctx.tabs.urlContains("/oauth2/consent")
      },
      {
        name: "device_consent_url",
        check: () => ctx.tabs.urlContains("/oauth2/device/consent")
      },
      {
        name: "device_login",
        check: () => findDeviceLoginPage(ctx)
      },
      {
        name: "allow_button",
        check: () => findVisibleConsentAllowButton(ctx)
      }
    ], {
      timeoutMs: 30000,
      label: "xAI OAuth consent 或 device 页面",
      signal: ctx.signal
    });
    if (!readyResult.matched) {
      return NodeResult.fail("xai_oauth_unexpected_url", `访问 xAI OAuth 后未进入 consent 或 device 页面: ${await ctx.tabs.getCurrentUrl()}`);
    }
    if (readyResult.name === "rate_limited_url") {
      return NodeResult.ok("xai_oauth_rate_limited_retry", {
        currentUrl: readyResult.value,
        attempt,
        xaiOauthUrl: oauth
      });
    }

    const isDeviceFlow = isXAiDeviceOauthUrl(oauth.url) || readyResult.name.startsWith("device_");
    if (readyResult.name === "device_login") {
      const continueResult = await clickVisibleButtonByText(ctx, getPageTextTerms("continueAction"));
      if (!continueResult.ok) {
        return NodeResult.fail("xai_oauth_device_continue_failed", "未能点击 xAI device 登录继续按钮", {
          currentUrl: await ctx.tabs.getCurrentUrl(),
          xaiOauthUrl: oauth
        });
      }
      const deviceConsentResult = await waitForAnyCondition([
        {
          name: "rate_limited_url",
          check: () => getRateLimitedOauthUrl(ctx)
        },
        {
          name: "device_consent_url",
          check: () => ctx.tabs.urlContains("/oauth2/device/consent")
        },
        {
          name: "allow_button",
          check: () => findVisibleConsentAllowButton(ctx)
        }
      ], {
        timeoutMs: 30000,
        label: "xAI device consent 页面",
        signal: ctx.signal
      });
      if (deviceConsentResult.name === "rate_limited_url") {
        return NodeResult.ok("xai_oauth_rate_limited_retry", {
          currentUrl: deviceConsentResult.value,
          attempt,
          xaiOauthUrl: oauth
        });
      }
      if (!deviceConsentResult.matched) {
        return NodeResult.fail("xai_oauth_unexpected_url", `点击 xAI device 继续后未进入 consent 页面: ${await ctx.tabs.getCurrentUrl()}`);
      }
    }

    const currentUrl = await ctx.tabs.getCurrentUrl();
    const oauthFlow = isDeviceFlow ? "device" : "authorization_code";
    logger.info(oauthFlow === "device" ? "xAI device OAuth consent 已就绪" : "xAI OAuth consent 已就绪", {
      currentUrl,
      userCode: oauthFlow === "device" ? resolveDeviceUserCode(oauth.url) : ""
    });
    return NodeResult.ok(XAiRefreshOAuthAndLoginNode.statuses.consent, {
      xaiOauthUrl: oauth,
      xaiOauthFlow: oauthFlow,
      xaiOauthDeviceUserCode: oauthFlow === "device" ? resolveDeviceUserCode(oauth.url) : "",
      currentUrl
    });
  }
}

async function getRateLimitedOauthUrl(ctx) {
  const currentUrl = await ctx.tabs.getCurrentUrl();
  return isXAiOauthRateLimitedUrl(currentUrl) ? currentUrl : null;
}

async function findDeviceLoginPage(ctx) {
  return ctx.tabs.execute((titleTerms, continueTerms) => {
    const title = Array.from(document.querySelectorAll("h1"))
      .map((item) => String(item.textContent || "").trim())
      .find((text) => {
        const normalized = text.toLowerCase();
        return titleTerms.some((term) => normalized === term);
      });
    if (!title) {
      return null;
    }
    const button = Array.from(document.querySelectorAll("button"))
      .find((item) => {
        const text = String(item.textContent || "").trim().toLowerCase();
        return isClickable(item) && continueTerms.some((term) => text.includes(term));
      });
    return button ? {
      title,
      buttonText: String(button.textContent || "").trim()
    } : null;

    function isClickable(element) {
      const style = window.getComputedStyle(element);
      return style.visibility !== "hidden"
        && style.display !== "none"
        && element.getClientRects().length > 0
        && !element.disabled
        && element.getAttribute("aria-disabled") !== "true";
    }
  }, [
    getPageTextTerms("xaiDeviceLoginTitle").map((term) => term.toLowerCase()),
    getPageTextTerms("continueAction").map((term) => term.toLowerCase())
  ]);
}

function isXAiDeviceOauthUrl(value) {
  try {
    return new URL(value || "").pathname.startsWith("/oauth2/device");
  } catch {
    return false;
  }
}

function isXAiOauthRateLimitedUrl(value) {
  try {
    const url = new URL(value || "");
    return url.pathname.startsWith("/oauth2/device")
      && url.searchParams.get("error") === "rate_limited";
  } catch {
    return false;
  }
}

function resolveDeviceUserCode(value) {
  try {
    return new URL(value || "").searchParams.get("user_code") || "";
  } catch {
    return "";
  }
}

function formatServiceError(error) {
  const message = `${error.name}: ${error.message}`;
  if (error.url) {
    return `${message}；URL=${error.url}`;
  }
  return message;
}
