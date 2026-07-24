import { RegisterNode, NodeResult, buildFlowStoppedResult } from "../core/flow.js";
import { sleep, waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";
import { appendRegisterHistory } from "../core/storage.js";
import { ACCOUNT_TYPES, RUN_MODES, isXAiRegisterMode, isXAiReauthorizeMode } from "../core/runModes.js";
import { getPageTextTerms } from "../core/pageText.js";
import { XAI_OAUTH_AUTH_MODES, isLocalXAiOauthAuthMode, normalizeXAiOauthAuthMode } from "../core/xaiOauthAuthModes.js";
import {
  buildXAiRedirectUrl,
  clickVisibleConsentAllowButton,
  findVisibleConsentAllowButton,
  getReadonlyAuthorizationCode
} from "./xaiHelpers.js";

const logger = createLogger("node.xai-consent");
const XAI_LOCAL_OAUTH_TOKEN_MAX_RETRIES = 3;

export class XAiSubmitConsentNode extends RegisterNode {
  static name = "xai_submit_consent";
  static statuses = {
    success: "xai_account_exported",
    retryLocalOauth: "xai_local_oauth_retry"
  };

  constructor() {
    super(XAiSubmitConsentNode.name, "xAI 账号导出");
  }

  async execute(ctx) {
    if (isLocalXAiOauthFlow(ctx)) {
      return this.executeLocalDeviceOauth(ctx);
    }
    if (isDeviceOauthFlow(ctx)) {
      return this.executeDeviceOauth(ctx);
    }
    return this.executeAuthorizationCodeOauth(ctx);
  }

  async executeLocalDeviceOauth(ctx) {
    const localOauth = ctx.state.xaiLocalOauth || null;
    if (!localOauth?.deviceCode || !localOauth?.tokenEndpoint) {
      return NodeResult.fail("xai_local_oauth_context_missing", "xAI 本地认证缺少 device_code/token_endpoint，请从刷新 OAuth 节点重新开始", {
        xaiOauthUrl: ctx.state.xaiOauthUrl || null
      });
    }

    const approvalResult = await waitAndApproveLocalDeviceConsent(ctx);
    if (!approvalResult.ok) {
      if (approvalResult.retryable && getLocalOauthRetryCount(ctx) < XAI_LOCAL_OAUTH_TOKEN_MAX_RETRIES) {
        const retryCount = getLocalOauthRetryCount(ctx) + 1;
        logger.warn("xAI 本地 OAuth 授权未成功，将重新申请 device code", {
          retryCount,
          maxRetryCount: XAI_LOCAL_OAUTH_TOKEN_MAX_RETRIES,
          status: approvalResult.status,
          error: approvalResult.error
        });
        return NodeResult.ok(XAiSubmitConsentNode.statuses.retryLocalOauth, {
          xaiLocalOauthRetryCount: retryCount,
          xaiLocalOauth: null,
          xaiOauthUrl: null,
          xaiOauthDeviceUserCode: "",
          xaiOauthAllowSubmittedAt: ""
        });
      }
      return NodeResult.fail(approvalResult.status, approvalResult.error, {
        xaiOauthUrl: ctx.state.xaiOauthUrl || null,
        xaiOauthDeviceUserCode: resolveDeviceUserCode(ctx.state.xaiOauthUrl)
      });
    }
    const allowSubmittedAt = approvalResult.allowSubmittedAt;
    ctx.state.xaiOauthAllowSubmittedAt = allowSubmittedAt;

    let tokenPayload;
    try {
      tokenPayload = await ctx.services.xaiLocalOAuthService.pollToken(localOauth, {
        signal: ctx.signal
      });
    } catch (error) {
      if (ctx.signal?.aborted || error.name === "AbortError") {
        return buildFlowStoppedResult();
      }
      if (shouldRetryLocalOauth(ctx, error)) {
        const retryCount = getLocalOauthRetryCount(ctx) + 1;
        logger.warn("xAI 本地 OAuth token 获取失败，将重新申请 device code", {
          retryCount,
          maxRetryCount: XAI_LOCAL_OAUTH_TOKEN_MAX_RETRIES,
          code: error.code || "",
          status: error.status || 0,
          error: formatServiceError(error)
        });
        return NodeResult.ok(XAiSubmitConsentNode.statuses.retryLocalOauth, {
          xaiLocalOauthRetryCount: retryCount,
          xaiLocalOauth: null,
          xaiOauthUrl: null,
          xaiOauthDeviceUserCode: "",
          xaiOauthAllowSubmittedAt: ""
        });
      }
      return NodeResult.fail("xai_local_oauth_token_failed", `xAI 本地 OAuth token 获取失败：${formatServiceError(error)}`, {
        xaiOauthUrl: ctx.state.xaiOauthUrl || null,
        xaiOauthDeviceUserCode: resolveDeviceUserCode(ctx.state.xaiOauthUrl),
        tokenError: {
          code: error.code || "",
          status: error.status || 0,
          retryable: Boolean(error.retryable)
        }
      });
    }

    const authFile = ctx.services.xaiLocalOAuthService.buildAuthFile(tokenPayload, {
      emailAddress: ctx.state.account?.emailAddress || "",
      tokenEndpoint: localOauth.tokenEndpoint
    });

    let uploadResult;
    try {
      uploadResult = await ctx.services.accountManagementService.uploadXAiAuthFile({
        emailAddress: ctx.state.account?.emailAddress || "",
        authFile,
        signal: ctx.signal
      });
    } catch (error) {
      if (ctx.signal?.aborted || error.name === "AbortError") {
        return buildFlowStoppedResult();
      }
      return NodeResult.fail("xai_account_export_failed", `CPA xAI 本地认证文件上传失败：${formatServiceError(error)}`, {
        xaiOauthUrl: ctx.state.xaiOauthUrl || null,
        xaiOauthDeviceUserCode: resolveDeviceUserCode(ctx.state.xaiOauthUrl),
        xaiAuthFileUploadResult: {
          success: false,
          error: formatServiceError(error)
        }
      });
    }

    const submitResult = {
      success: true,
      status: "xai_local_auth_file_uploaded",
      error: "",
      attributes: uploadResult.attributes || {},
      xaiAuthFileUploadResult: uploadResult,
      xaiAuthFilePatchResult: uploadResult
    };
    await finalizeXAiAccountExport(ctx, {
      authorizationCode: "",
      oauthState: "",
      redirectUrl: "",
      oauthFlow: "device",
      oauthAuthMode: XAI_OAUTH_AUTH_MODES.local,
      deviceUserCode: resolveDeviceUserCode(ctx.state.xaiOauthUrl),
      submitResult
    });

    logger.info("xAI 本地 OAuth 账号导出完成", {
      email: ctx.state.account?.emailAddress,
      fileName: uploadResult.fileName || "",
      userCode: resolveDeviceUserCode(ctx.state.xaiOauthUrl),
      lastRefresh: authFile.last_refresh
    });
    return NodeResult.ok(XAiSubmitConsentNode.statuses.success, {
      xaiOauthFlow: "device",
      xaiOauthAuthMode: XAI_OAUTH_AUTH_MODES.local,
      xaiOauthDeviceUserCode: resolveDeviceUserCode(ctx.state.xaiOauthUrl),
      xaiOauthAllowSubmittedAt: allowSubmittedAt,
      xaiAuthFileUploadResult: uploadResult,
      accountExportSubmitResult: submitResult
    });
  }

  async executeDeviceOauth(ctx) {
    const consentReady = await waitForAnyCondition([
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
      label: "xAI device OAuth consent 授权按钮",
      signal: ctx.signal
    });
    if (!consentReady.matched) {
      return NodeResult.fail("xai_oauth_consent_missing", `未找到 xAI device OAuth consent 页面或允许按钮: ${await ctx.tabs.getCurrentUrl()}`);
    }

    logger.info("xAI device consent 已就绪，提交前等待页面稳定", {
      waitMs: 2000,
      currentUrl: await ctx.tabs.getCurrentUrl()
    });
    await sleep(2000, ctx.signal);
    if (ctx.signal?.aborted) {
      return NodeResult.fail("stopped", "流程已停止");
    }

    const deleteResult = await prepareExistingXAiAuthFileForAccountServicePatch(ctx);
    if (!deleteResult.ok) {
      return NodeResult.fail("xai_auth_file_delete_failed", deleteResult.error, {
        xaiOauthUrl: ctx.state.xaiOauthUrl || null,
        xaiAuthFileDeleteResult: deleteResult.data
      });
    }

    const clickResult = await approveDeviceConsent(ctx);
    if (!clickResult.ok) {
      return NodeResult.fail("xai_oauth_allow_failed", "未能点击 xAI device OAuth 允许按钮");
    }
    const allowSubmittedAt = new Date().toISOString();
    ctx.state.xaiOauthAllowSubmittedAt = allowSubmittedAt;

    const doneResult = await waitForAnyCondition([
      {
        name: "device_done_url",
        check: () => ctx.tabs.urlContains("/oauth2/device/done")
      }
    ], {
      timeoutMs: 30000,
      label: "xAI device OAuth done 页面",
      signal: ctx.signal
    });
    if (!doneResult.matched) {
      return NodeResult.fail("xai_oauth_device_done_missing", `点击 xAI device 允许后未进入完成页: ${await ctx.tabs.getCurrentUrl()}`);
    }

    let patchResult;
    try {
      patchResult = await ctx.services.accountManagementService.patchXAiAuthFile({
        emailAddress: ctx.state.account?.emailAddress || "",
        minLastRefreshAt: getRequiredMinLastRefreshAt(ctx, allowSubmittedAt),
        signal: ctx.signal
      });
    } catch (error) {
      if (ctx.signal?.aborted || error.name === "AbortError") {
        return buildFlowStoppedResult();
      }
      return NodeResult.fail("xai_account_export_failed", `CPA xAI device 认证文件修补失败：${formatServiceError(error)}`, {
        xaiOauthUrl: ctx.state.xaiOauthUrl || null,
        xaiOauthDeviceUserCode: resolveDeviceUserCode(ctx.state.xaiOauthUrl),
        xaiAuthFilePatchResult: {
          success: false,
          error: formatServiceError(error)
        }
      });
    }

    const submitResult = {
      success: true,
      status: "xai_device_auth_file_patched",
      error: "",
      attributes: {},
      xaiAuthFilePatchResult: patchResult
    };
    await finalizeXAiAccountExport(ctx, {
      authorizationCode: "",
      oauthState: "",
      redirectUrl: "",
      oauthFlow: "device",
      deviceUserCode: resolveDeviceUserCode(ctx.state.xaiOauthUrl),
      submitResult
    });

    logger.info("xAI device 账号导出完成", {
      email: ctx.state.account?.emailAddress,
      userCode: resolveDeviceUserCode(ctx.state.xaiOauthUrl)
    });
    return NodeResult.ok(XAiSubmitConsentNode.statuses.success, {
      xaiOauthFlow: "device",
      xaiOauthDeviceUserCode: resolveDeviceUserCode(ctx.state.xaiOauthUrl),
      xaiOauthAllowSubmittedAt: allowSubmittedAt,
      xaiAuthFileDeleteResult: deleteResult.data,
      accountExportSubmitResult: submitResult
    });
  }

  async executeAuthorizationCodeOauth(ctx) {
    const consentReady = await waitForAnyCondition([
      {
        name: "consent_url",
        check: () => ctx.tabs.urlContains("/oauth2/consent")
      },
      {
        name: "allow_button",
        check: () => findVisibleConsentAllowButton(ctx)
      }
    ], {
      timeoutMs: 30000,
      label: "xAI OAuth consent 授权按钮",
      signal: ctx.signal
    });
    if (!consentReady.matched) {
      return NodeResult.fail("xai_oauth_consent_missing", `未找到 xAI OAuth consent 页面或允许按钮: ${await ctx.tabs.getCurrentUrl()}`);
    }

    const allowButtonReady = await waitForAnyCondition([
      {
        name: "allow_button",
        check: () => findVisibleConsentAllowButton(ctx)
      }
    ], {
      timeoutMs: 30000,
      label: "xAI OAuth 允许按钮",
      signal: ctx.signal
    });
    if (!allowButtonReady.matched) {
      return NodeResult.fail("xai_oauth_consent_missing", `未找到 xAI OAuth 允许按钮: ${await ctx.tabs.getCurrentUrl()}`);
    }

    const clickResult = await clickVisibleConsentAllowButton(ctx);
    if (!clickResult.ok) {
      return NodeResult.fail("xai_oauth_allow_failed", "未能点击 xAI OAuth 允许按钮");
    }
    const allowSubmittedAt = new Date().toISOString();
    ctx.state.xaiOauthAllowSubmittedAt = allowSubmittedAt;

    const codeResult = await waitForAnyCondition([
      {
        name: "authorization_code",
        check: () => getReadonlyAuthorizationCode(ctx)
      }
    ], {
      timeoutMs: 30000,
      label: "xAI OAuth 授权码",
      signal: ctx.signal
    });
    if (!codeResult.matched || !codeResult.value) {
      return NodeResult.fail("xai_oauth_code_missing", `点击允许后未获取到 xAI 授权码: ${await ctx.tabs.getCurrentUrl()}`);
    }

    const authorizationCode = String(codeResult.value || "").trim();
    const oauthState = resolveOauthState(ctx.state.xaiOauthUrl);
    if (!oauthState) {
      return NodeResult.fail("xai_oauth_state_missing", "xAI OAuth 链接缺少 state 参数，无法提交回调地址", {
        xaiOauthUrl: ctx.state.xaiOauthUrl || null,
        xaiAuthorizationCode: authorizationCode
      });
    }
    const redirectUrl = buildXAiRedirectUrl(authorizationCode, oauthState);
    const deleteResult = await prepareExistingXAiAuthFileForAccountServicePatch(ctx);
    if (!deleteResult.ok) {
      return NodeResult.fail("xai_auth_file_delete_failed", deleteResult.error, {
        xaiOauthRedirectUrl: redirectUrl,
        xaiAuthorizationCode: authorizationCode,
        xaiAuthFileDeleteResult: deleteResult.data
      });
    }
    const submitResult = await ctx.services.accountManagementService.submitRedirectUrl(redirectUrl, {
      accountType: ACCOUNT_TYPES.xai,
      emailAddress: ctx.state.account?.emailAddress || "",
      minLastRefreshAt: getRequiredMinLastRefreshAt(ctx, allowSubmittedAt),
      signal: ctx.signal
    });
    if (!submitResult.success) {
      return NodeResult.fail("xai_account_export_failed", submitResult.error || `xAI 账号导出失败: ${submitResult.status}`, {
        xaiOauthRedirectUrl: redirectUrl,
        xaiAuthorizationCode: authorizationCode,
        accountExportSubmitResult: submitResult
      });
    }

    await finalizeXAiAccountExport(ctx, {
      authorizationCode,
      oauthState,
      redirectUrl,
      oauthFlow: "authorization_code",
      deviceUserCode: "",
      submitResult
    });

    logger.info("xAI 账号导出完成", {
      email: ctx.state.account?.emailAddress,
      password: ctx.state.account?.password,
      name: ctx.state.account?.name,
      emailVerificationCode: ctx.state.account?.emailVerificationCode
    });
    return NodeResult.ok(XAiSubmitConsentNode.statuses.success, {
      xaiAuthorizationCode: authorizationCode,
      xaiOauthState: oauthState,
      xaiOauthRedirectUrl: redirectUrl,
      xaiOauthAllowSubmittedAt: allowSubmittedAt,
      xaiAuthFileDeleteResult: deleteResult.data,
      accountExportSubmitResult: submitResult
    });
  }
}

async function waitAndApproveLocalDeviceConsent(ctx) {
  const consentReady = await waitForAnyCondition([
    {
      name: "device_done_url",
      check: () => ctx.tabs.urlContains("/oauth2/device/done")
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
    label: "xAI 本地 device OAuth consent 或 done 页面",
    signal: ctx.signal
  });
  if (!consentReady.matched) {
    return {
      ok: false,
      status: "xai_oauth_consent_missing",
      error: `未找到 xAI 本地 device OAuth consent 或完成页: ${await ctx.tabs.getCurrentUrl()}`
    };
  }
  if (consentReady.name === "device_done_url") {
    return {
      ok: true,
      allowSubmittedAt: ctx.state.xaiOauthAllowSubmittedAt || new Date().toISOString(),
      alreadyDone: true
    };
  }

  const allowReady = await waitForAnyCondition([
    {
      name: "allow_button",
      check: () => findVisibleConsentAllowButton(ctx)
    }
  ], {
    timeoutMs: 30000,
    label: "xAI 本地 device OAuth 允许按钮",
    signal: ctx.signal
  });
  if (!allowReady.matched) {
    return {
      ok: false,
      status: "xai_oauth_consent_missing",
      error: `xAI 本地 device OAuth consent 页面未出现允许按钮: ${await ctx.tabs.getCurrentUrl()}`
    };
  }

  logger.info("xAI 本地 device consent 已就绪，提交前等待页面稳定", {
    waitMs: 2000,
    currentUrl: await ctx.tabs.getCurrentUrl()
  });
  await sleep(2000, ctx.signal);
  if (ctx.signal?.aborted) {
    return {
      ok: false,
      status: "stopped",
      error: "流程已停止"
    };
  }

  const clickResult = await approveDeviceConsent(ctx);
  if (!clickResult.ok) {
    return {
      ok: false,
      status: "xai_oauth_allow_failed",
      error: "未能点击 xAI 本地 device OAuth 允许按钮"
    };
  }
  logger.info("xAI 本地 device OAuth 允许表单已提交", {
    actionValue: clickResult.actionValue || "",
    actionSource: clickResult.actionSource || "",
    payload: clickResult.payload || null,
    form: clickResult.form || null,
    button: clickResult.button || null
  });
  const allowSubmittedAt = new Date().toISOString();

  const doneResult = await waitForAnyCondition([
    {
      name: "device_done_url",
      check: () => ctx.tabs.urlContains("/oauth2/device/done")
    }
  ], {
    timeoutMs: 30000,
    label: "xAI 本地 device OAuth done 页面",
    signal: ctx.signal
  });
  if (!doneResult.matched) {
    return {
      ok: false,
      status: "xai_oauth_device_done_missing",
      error: `点击 xAI 本地 device 允许后未进入完成页: ${await ctx.tabs.getCurrentUrl()}`
    };
  }
  const doneStatus = await inspectDeviceDonePage(ctx);
  logger.info("xAI 本地 device OAuth done 页面状态", doneStatus);
  if (doneStatus.state === "denied") {
    return {
      ok: false,
      retryable: true,
      status: "xai_local_oauth_denied",
      error: `xAI 本地 device OAuth done 页面显示授权被拒绝: ${doneStatus.preview || await ctx.tabs.getCurrentUrl()}`
    };
  }
  return {
    ok: true,
    allowSubmittedAt,
    alreadyDone: false
  };
}

async function prepareExistingXAiAuthFileForAccountServicePatch(ctx) {
  if (isXAiReauthorizeMode(ctx.config.register?.mode)) {
    logger.info("xAI 授权模式跳过删除已有 CPA xAI 认证文件，将按 last_refresh 等待本次授权生成的新文件", {
      email: ctx.state.account?.emailAddress || ""
    });
    return {
      ok: true,
      data: {
        deleted: false,
        skipped: true,
        reason: "xai_reauthorize_keep_existing_auth_file"
      }
    };
  }
  return deleteExistingXAiAuthFile(ctx);
}

async function deleteExistingXAiAuthFile(ctx) {
  const emailAddress = String(ctx.state.account?.emailAddress || "").trim();
  if (!emailAddress) {
    return {
      ok: false,
      error: "删除 CPA xAI 认证文件失败：缺少 xAI 邮箱地址",
      data: null
    };
  }

  try {
    const result = await ctx.services.accountManagementService.deleteAccount({
      accountType: ACCOUNT_TYPES.xai,
      emailAddress
    });
    if (!result?.success) {
      return {
        ok: false,
        error: result?.error || `删除 CPA xAI 认证文件失败: ${result?.status || "unknown"}`,
        data: result || null
      };
    }
    logger.info("已删除已有 CPA xAI 认证文件，等待本次授权写入新文件", {
      email: emailAddress,
      fileName: result.fileName || "",
      status: result.status || "ok"
    });
    return {
      ok: true,
      data: {
        deleted: true,
        fileName: result.fileName || "",
        status: result.status || "ok"
      }
    };
  } catch (error) {
    if (Number(error?.status) === 404) {
      logger.info("CPA xAI 认证文件不存在，继续本次授权写入流程", { email: emailAddress });
      return {
        ok: true,
        data: {
          deleted: false,
          missing: true,
          status: "not_found"
        }
      };
    }
    return {
      ok: false,
      error: `删除 CPA xAI 认证文件失败：${formatServiceError(error)}`,
      data: {
        status: error?.status || 0,
        error: formatServiceError(error)
      }
    };
  }
}

async function inspectDeviceDonePage(ctx) {
  return ctx.tabs.execute(() => {
    const text = String(document.body?.innerText || document.body?.textContent || "")
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim();
    const normalized = text.toLowerCase();
    const denied = [
      "access denied",
      "denied",
      "declined",
      "rejected",
      "not authorized",
      "authorization denied",
      "拒绝",
      "未授权",
      "不同意",
      "不允许"
    ].some((term) => normalized.includes(term));
    const authorized = [
      "device authorized",
      "you have authorized",
      "device is authorized",
      "authorized",
      "设备已授权",
      "授权成功",
      "已授权"
    ].some((term) => normalized.includes(term));
    return {
      state: denied ? "denied" : authorized ? "authorized" : "unknown",
      url: window.location.href,
      preview: text.slice(0, 180)
    };
  });
}

async function approveDeviceConsent(ctx) {
  return ctx.tabs.execute((positiveKeywords, negativeKeywords) => {
    const button = findPositiveSubmitButton();
    const form = button?.form
      || document.querySelector("form[action*='/oauth2/device/approve']")
      || document.querySelector("form");
    if (!button || !form) {
      return {
        ok: false,
        reason: button ? "form_missing" : "button_missing",
        form: form ? describeForm(form) : null
      };
    }

    const actionTarget = setDeviceActionValue(form, button, "allow");

    button.scrollIntoView({ block: "center", inline: "center" });
    if (typeof form.requestSubmit === "function" && actionTarget.source === "button" && isSubmitControl(button)) {
      form.requestSubmit(button);
    } else if (typeof form.requestSubmit === "function") {
      form.requestSubmit();
    } else {
      button.click();
    }

    return {
      ok: true,
      actionValue: actionTarget.value,
      actionSource: actionTarget.source,
      button: describeButton(button),
      form: describeForm(form)
    };

    function findPositiveSubmitButton() {
      return Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit']"))
        .map((item) => ({ item, score: scoreButton(item) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score)[0]?.item || null;
    }

    function scoreButton(element) {
      if (!isClickable(element)) {
        return 0;
      }
      const text = getButtonText(element).toLowerCase();
      if (!text || !positiveKeywords.some((keyword) => text.includes(keyword))) {
        return 0;
      }
      if (negativeKeywords.some((keyword) => keyword && text.includes(keyword))) {
        return 0;
      }
      let score = 10;
      if (positiveKeywords.some((keyword) => text === keyword)) {
        score += 100;
      }
      const actionText = [
        element.getAttribute("name"),
        element.getAttribute("value"),
        element.getAttribute("data-action"),
        element.getAttribute("aria-label")
      ].filter(Boolean).join(" ").toLowerCase();
      if (/(approve|allow|authorize|accept|consent)/.test(actionText)) {
        score += 40;
      }
      if (element.form?.getAttribute("action")?.includes("/oauth2/device/approve")) {
        score += 30;
      }
      return score;
    }

    function setDeviceActionValue(formElement, buttonElement, value) {
      const normalizedValue = String(value || "allow").trim() || "allow";
      const existingInput = formElement.querySelector("input[name='action']");
      if (existingInput) {
        setNativeValue(existingInput, normalizedValue);
        existingInput.dispatchEvent(new InputEvent("input", { bubbles: true, data: existingInput.value, inputType: "insertText" }));
        existingInput.dispatchEvent(new Event("change", { bubbles: true }));
        return {
          source: "input",
          value: existingInput.value
        };
      }

      if (buttonElement.getAttribute("name") === "action") {
        if (buttonElement instanceof HTMLInputElement) {
          setNativeValue(buttonElement, normalizedValue);
        }
        buttonElement.setAttribute("value", normalizedValue);
        return {
          source: "button",
          value: normalizedValue
        };
      }

      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "action";
      input.value = normalizedValue;
      formElement.append(input);
      return {
        source: "created_input",
        value: input.value
      };
    }

    function setNativeValue(target, nextValue) {
      const prototype = target instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (valueSetter) {
        valueSetter.call(target, nextValue);
        return;
      }
      target.value = nextValue;
    }

    function isSubmitControl(element) {
      if (element instanceof HTMLInputElement) {
        return ["submit", "image"].includes((element.getAttribute("type") || "submit").toLowerCase());
      }
      if (element instanceof HTMLButtonElement) {
        return (element.getAttribute("type") || "submit").toLowerCase() === "submit";
      }
      return false;
    }

    function describeButton(element) {
      return {
        text: getButtonText(element),
        type: element.getAttribute("type") || "",
        name: element.getAttribute("name") || "",
        value: element.getAttribute("value") || "",
        dataAction: element.getAttribute("data-action") || ""
      };
    }

    function describeForm(element) {
      return {
        action: element.getAttribute("action") || "",
        method: element.getAttribute("method") || "",
        userCode: element.querySelector("input[name='user_code']")?.value || "",
        actionValue: element.querySelector("input[name='action']")?.value || "",
        principalType: element.querySelector("input[name='principal_type']")?.value || "",
        principalId: element.querySelector("input[name='principal_id']")?.value || ""
      };
    }

    function getButtonText(element) {
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
    getPageTextTerms("consentAllow").map((term) => term.toLowerCase()),
    getPageTextTerms("consentDeny").map((term) => term.toLowerCase())
  ]);
}

async function finalizeXAiAccountExport(ctx, {
  authorizationCode,
  oauthState,
  redirectUrl,
  oauthFlow,
  oauthAuthMode,
  deviceUserCode,
  submitResult
}) {
  await ctx.services.emailService.callback(ctx.state.emailAccount, true);
  if (isXAiRegisterMode(ctx.config.register?.mode)) {
    await appendRegisterHistory({
      accountType: ACCOUNT_TYPES.xai,
      flowMode: RUN_MODES.xaiRegister,
      emailAddress: ctx.state.account?.emailAddress || "",
      mobile: "",
      smsProvider: "",
      activationId: "",
      name: ctx.state.account?.name || "",
      firstName: ctx.state.account?.firstName || "",
      lastName: ctx.state.account?.lastName || "",
      age: ctx.state.account?.age || "",
      birthDate: ctx.state.account?.birthDate?.value || "",
      password: ctx.state.account?.password || "",
      emailProvider: "outlook_mail",
      emailMode: resolveEmailMode(ctx.state.emailAccount),
      emailAccount: ctx.state.emailAccount || null,
      outlookAccountId: ctx.state.emailAccount?.attributes?.accountId || "",
      emailVerificationCode: ctx.state.account?.emailVerificationCode || "",
      smsVerificationCode: "",
      xaiOauthFlow: oauthFlow || "",
      xaiOauthAuthMode: normalizeXAiOauthAuthMode(oauthAuthMode || ctx.state.xaiOauthAuthMode),
      xaiOauthDeviceUserCode: deviceUserCode || "",
      xaiAuthorizationCode: authorizationCode || "",
      xaiOauthState: oauthState || "",
      xaiOauthRedirectUrl: redirectUrl || "",
      accountExportStatus: submitResult.status,
      accountExportResult: submitResult.attributes || {},
      xaiAuthFilePatchResult: submitResult.xaiAuthFilePatchResult || null,
      xaiAuthFileUploadResult: submitResult.xaiAuthFileUploadResult || null
    });
  }
}

function getRequiredMinLastRefreshAt(ctx, allowSubmittedAt) {
  return isXAiReauthorizeMode(ctx.config.register?.mode)
    ? allowSubmittedAt
    : "";
}

function isDeviceOauthFlow(ctx) {
  return ctx.state?.xaiOauthFlow === "device" || isXAiDeviceOauthUrl(ctx.state?.xaiOauthUrl?.url);
}

function isLocalXAiOauthFlow(ctx) {
  return isLocalXAiOauthAuthMode(ctx.state?.xaiOauthAuthMode || ctx.config.register?.xaiOauthAuthMode)
    && isDeviceOauthFlow(ctx);
}

function shouldRetryLocalOauth(ctx, error) {
  if (!isLocalXAiOauthFlow(ctx)) {
    return false;
  }
  if (getLocalOauthRetryCount(ctx) >= XAI_LOCAL_OAUTH_TOKEN_MAX_RETRIES) {
    return false;
  }
  return Boolean(error?.retryable)
    || ["invalid_grant", "expired_token", "token_polling_timeout"].includes(String(error?.code || ""));
}

function getLocalOauthRetryCount(ctx) {
  const count = Math.floor(Number(ctx.state?.xaiLocalOauthRetryCount || 0));
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function isXAiDeviceOauthUrl(value) {
  try {
    return new URL(value || "").pathname.startsWith("/oauth2/device");
  } catch {
    return false;
  }
}

function resolveDeviceUserCode(oauth = {}) {
  if (oauth.userCode || oauth.user_code || oauth.deviceUserCode) {
    return String(oauth.userCode || oauth.user_code || oauth.deviceUserCode).trim();
  }
  try {
    return new URL(oauth.url || "").searchParams.get("user_code") || "";
  } catch {
    return "";
  }
}

function resolveOauthState(oauth = {}) {
  if (oauth.state) {
    return String(oauth.state).trim();
  }
  try {
    return new URL(oauth.url || "").searchParams.get("state") || "";
  } catch {
    return "";
  }
}

function resolveEmailMode(emailAccount) {
  if (emailAccount?.attributes?.mode === "temp") {
    return "temp";
  }
  return "outlook_pool";
}

function formatServiceError(error) {
  const message = `${error.name || "Error"}: ${error.message || String(error)}`;
  if (error.url) {
    return `${message}；URL=${error.url}`;
  }
  return message;
}
