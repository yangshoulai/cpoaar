import { RegisterNode, NodeResult } from "../core/flow.js";
import { sleep, waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";
import { ACCOUNT_TYPES } from "../core/runModes.js";
import { getPageTextTerms } from "../core/pageText.js";
import { XAI_OAUTH_AUTH_MODES, isLocalXAiOauthAuthMode, normalizeXAiOauthAuthMode } from "../core/xaiOauthAuthModes.js";
import {
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
    const authMode = normalizeXAiOauthAuthMode(ctx.config.register?.xaiOauthAuthMode);
    if (isLocalXAiOauthAuthMode(authMode)) {
      return this.executeLocalOauthAttempt(ctx, attempt);
    }
    return this.executeAccountServiceOauthAttempt(ctx, attempt);
  }

  async executeAccountServiceOauthAttempt(ctx, attempt) {
    let oauth;
    try {
      oauth = await ctx.services.accountManagementService.getOauthUrl({
        accountType: ACCOUNT_TYPES.xai
      });
    } catch (error) {
      return NodeResult.fail("xai_oauth_request_failed", formatServiceError(error));
    }
    ctx.state.xaiOauthUrl = oauth;
    ctx.state.xaiOauthAuthMode = XAI_OAUTH_AUTH_MODES.accountService;
    ctx.state.xaiLocalOauth = null;
    logger.info("访问 xAI OAuth 链接", {
      attempt,
      maxAttempts: XAI_OAUTH_RATE_LIMIT_MAX_ATTEMPTS,
      authMode: XAI_OAUTH_AUTH_MODES.accountService,
      oauthFlow: oauth.oauthFlow || "",
      userCode: oauth.userCode || "",
      url: oauth.url
    });
    await ctx.tabs.navigate(oauth.url);
    return waitForOauthConsentReady(ctx, oauth, attempt);
  }

  async executeLocalOauthAttempt(ctx, attempt) {
    const ssoCookie = await ctx.tabs.getXAiSsoCookie();
    if (!ssoCookie?.value) {
      return NodeResult.fail("xai_local_oauth_sso_missing", "本地认证缺少 xAI sso Cookie，请确认浏览器已登录 xAI 账号", {
        currentUrl: await ctx.tabs.getCurrentUrl().catch(() => "")
      });
    }
    const cookieInjectResult = await ctx.tabs.ensureXAiSsoCookieForAuthHosts(ssoCookie.value, ssoCookie.storeId || "");
    logger.info("xAI 本地认证已获取 sso Cookie", {
      domain: ssoCookie.domain || "",
      path: ssoCookie.path || "",
      storeId: ssoCookie.storeId || "",
      httpOnly: Boolean(ssoCookie.httpOnly),
      secure: Boolean(ssoCookie.secure),
      valueLength: String(ssoCookie.value || "").length,
      injected: cookieInjectResult.injected,
      injectedCount: cookieInjectResult.count
    });

    let deviceAuthorization;
    try {
      deviceAuthorization = await ctx.services.xaiLocalOAuthService.startDeviceAuthorization({
        signal: ctx.signal
      });
    } catch (error) {
      if (ctx.signal?.aborted || error.name === "AbortError") {
        return NodeResult.fail("stopped", "流程已停止");
      }
      if (Number(error?.status || 0) === 429 || error.code === "rate_limited") {
        return NodeResult.ok("xai_oauth_rate_limited_retry", {
          currentUrl: "",
          attempt,
          authMode: XAI_OAUTH_AUTH_MODES.local,
          error: formatServiceError(error)
        });
      }
      return NodeResult.fail("xai_local_oauth_start_failed", `xAI 本地 OAuth 初始化失败：${formatServiceError(error)}`);
    }

    const oauth = {
      url: deviceAuthorization.verificationUrl,
      state: "",
      oauthFlow: "device",
      userCode: deviceAuthorization.userCode,
      local: true,
      tokenEndpoint: deviceAuthorization.tokenEndpoint,
      attributes: deviceAuthorization.attributes || {}
    };
    ctx.state.xaiOauthUrl = oauth;
    ctx.state.xaiOauthAuthMode = XAI_OAUTH_AUTH_MODES.local;
    ctx.state.xaiLocalOauth = deviceAuthorization;
    logger.info("访问 xAI 本地 OAuth 认证链接", {
      attempt,
      maxAttempts: XAI_OAUTH_RATE_LIMIT_MAX_ATTEMPTS,
      authMode: XAI_OAUTH_AUTH_MODES.local,
      userCode: deviceAuthorization.userCode,
      expiresIn: deviceAuthorization.expiresIn,
      interval: deviceAuthorization.interval,
      url: deviceAuthorization.verificationUrl
    });
    await ctx.tabs.navigate(deviceAuthorization.verificationUrl);
    return waitForOauthConsentReady(ctx, oauth, attempt, {
      includeDeviceDone: true
    });
  }
}

async function waitForOauthConsentReady(ctx, oauth, attempt, { includeDeviceDone = false } = {}) {
  const conditions = [
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
  ];
  if (includeDeviceDone) {
    conditions.push({
      name: "device_done_url",
      check: () => ctx.tabs.urlContains("/oauth2/device/done")
    });
  }
  const readyResult = await waitForAnyCondition(conditions, {
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
    const continueResult = await clickDeviceLoginSubmit(ctx);
    if (!continueResult.ok) {
      return NodeResult.fail("xai_oauth_device_continue_failed", "未能点击 xAI device 登录继续按钮", {
        currentUrl: await ctx.tabs.getCurrentUrl(),
        xaiOauthUrl: oauth
      });
    }
    const deviceConsentConditions = [
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
    ];
    if (includeDeviceDone) {
      deviceConsentConditions.push({
        name: "device_done_url",
        check: () => ctx.tabs.urlContains("/oauth2/device/done")
      });
    }
    const deviceConsentResult = await waitForAnyCondition(deviceConsentConditions, {
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
    authMode: normalizeXAiOauthAuthMode(ctx.state.xaiOauthAuthMode),
    userCode: oauthFlow === "device" ? resolveDeviceUserCode(oauth.url) || oauth.userCode || "" : ""
  });
  return NodeResult.ok(XAiRefreshOAuthAndLoginNode.statuses.consent, {
    xaiOauthUrl: oauth,
    xaiOauthFlow: oauthFlow,
    xaiOauthAuthMode: normalizeXAiOauthAuthMode(ctx.state.xaiOauthAuthMode),
    xaiLocalOauth: ctx.state.xaiLocalOauth || null,
    xaiOauthDeviceUserCode: oauthFlow === "device" ? resolveDeviceUserCode(oauth.url) || oauth.userCode || "" : "",
    currentUrl
  });
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
    const submitControl = findSubmitControl();
    const hasDeviceForm = Boolean(document.querySelector("form input[name='user_code'], form input[name='userCode']"));
    if (!title && !hasDeviceForm) {
      return null;
    }
    const continueButton = Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit']"))
      .find((item) => {
        const text = getControlText(item).toLowerCase();
        return isClickable(item) && continueTerms.some((term) => text.includes(term));
      });
    const control = submitControl || continueButton;
    return control ? {
      title,
      controlText: getControlText(control),
      controlType: control.getAttribute("type") || "",
      matchedBy: submitControl ? "submit_type" : "continue_text"
    } : null;

    function findSubmitControl() {
      return Array.from(document.querySelectorAll("button[type='submit'], input[type='submit']"))
        .find((item) => isClickable(item)) || null;
    }

    function getControlText(element) {
      if (element instanceof HTMLInputElement) {
        return String(element.value || element.getAttribute("aria-label") || "").trim();
      }
      return String(element.textContent || element.getAttribute("aria-label") || "").trim();
    }

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

async function clickDeviceLoginSubmit(ctx) {
  return ctx.tabs.execute((continueTerms) => {
    const submitControl = Array.from(document.querySelectorAll("button[type='submit'], input[type='submit']"))
      .find((item) => isClickable(item)) || null;
    const continueButton = submitControl
      ? null
      : Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit']"))
        .find((item) => isClickable(item) && continueTerms.some((term) => getControlText(item).toLowerCase().includes(term)));
    const control = submitControl || continueButton;
    if (!control) {
      return { ok: false, control: null };
    }
    control.scrollIntoView({ block: "center", inline: "center" });
    control.click();
    return {
      ok: true,
      matchedBy: submitControl ? "submit_type" : "continue_text",
      control: {
        text: getControlText(control),
        type: control.getAttribute("type") || "",
        name: control.getAttribute("name") || "",
        value: control.getAttribute("value") || ""
      }
    };

    function getControlText(element) {
      if (element instanceof HTMLInputElement) {
        return String(element.value || element.getAttribute("aria-label") || "").trim();
      }
      return String(element.textContent || element.getAttribute("aria-label") || "").trim();
    }

    function isClickable(element) {
      const style = window.getComputedStyle(element);
      return style.visibility !== "hidden"
        && style.display !== "none"
        && element.getClientRects().length > 0
        && !element.disabled
        && element.getAttribute("aria-disabled") !== "true";
    }
  }, [getPageTextTerms("continueAction").map((term) => term.toLowerCase())]);
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
