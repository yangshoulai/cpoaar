import { RegisterNode, NodeResult } from "../core/flow.js";
import { sleep, waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";
import { appendRegisterHistory } from "../core/storage.js";
import { ACCOUNT_TYPES, RUN_MODES } from "../core/runModes.js";
import {
  buildXAiRedirectUrl,
  clickVisibleButtonByText,
  findVisibleButtonByText,
  getReadonlyAuthorizationCode
} from "./xaiHelpers.js";

const logger = createLogger("node.xai-consent");

export class XAiSubmitConsentNode extends RegisterNode {
  static name = "xai_submit_consent";
  static statuses = {
    success: "xai_account_exported"
  };

  constructor() {
    super(XAiSubmitConsentNode.name, "xAI 账号导出");
  }

  async execute(ctx) {
    if (isDeviceOauthFlow(ctx)) {
      return this.executeDeviceOauth(ctx);
    }
    return this.executeAuthorizationCodeOauth(ctx);
  }

  async executeDeviceOauth(ctx) {
    const consentReady = await waitForAnyCondition([
      {
        name: "device_consent_url",
        check: () => ctx.tabs.urlContains("/oauth2/device/consent")
      },
      {
        name: "allow_button",
        check: () => findVisibleButtonByText(ctx, ["允许", "allow", "authorize"])
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

    const clickResult = await approveDeviceConsent(ctx);
    if (!clickResult.ok) {
      return NodeResult.fail("xai_oauth_allow_failed", "未能点击 xAI device OAuth 允许按钮");
    }

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
        emailAddress: ctx.state.account?.emailAddress || ""
      });
    } catch (error) {
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
        check: () => findVisibleButtonByText(ctx, ["允许", "allow", "authorize"])
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
        check: () => findVisibleButtonByText(ctx, ["允许", "allow", "authorize"])
      }
    ], {
      timeoutMs: 30000,
      label: "xAI OAuth 允许按钮",
      signal: ctx.signal
    });
    if (!allowButtonReady.matched) {
      return NodeResult.fail("xai_oauth_consent_missing", `未找到 xAI OAuth 允许按钮: ${await ctx.tabs.getCurrentUrl()}`);
    }

    const clickResult = await clickVisibleButtonByText(ctx, ["允许", "allow", "authorize"]);
    if (!clickResult.ok) {
      return NodeResult.fail("xai_oauth_allow_failed", "未能点击 xAI OAuth 允许按钮");
    }

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
    const submitResult = await ctx.services.accountManagementService.submitRedirectUrl(redirectUrl, {
      accountType: ACCOUNT_TYPES.xai,
      emailAddress: ctx.state.account?.emailAddress || ""
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
      accountExportSubmitResult: submitResult
    });
  }
}

async function approveDeviceConsent(ctx) {
  return ctx.tabs.execute(() => {
    const positiveKeywords = ["允许", "allow", "authorize", "approve"];
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
      if (isNegativeAllowText(text)) {
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

    function isNegativeAllowText(text) {
      return [
        "不允许",
        "拒绝",
        "取消",
        "don't allow",
        "do not allow",
        "deny",
        "decline",
        "reject",
        "cancel",
        "not now"
      ].some((keyword) => text.includes(keyword));
    }

    function isClickable(element) {
      const style = window.getComputedStyle(element);
      return style.visibility !== "hidden"
        && style.display !== "none"
        && element.getClientRects().length > 0
        && !element.disabled
        && element.getAttribute("aria-disabled") !== "true";
    }
  });
}

async function finalizeXAiAccountExport(ctx, {
  authorizationCode,
  oauthState,
  redirectUrl,
  oauthFlow,
  deviceUserCode,
  submitResult
}) {
  await ctx.services.emailService.callback(ctx.state.emailAccount, true);
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
    xaiOauthDeviceUserCode: deviceUserCode || "",
    xaiAuthorizationCode: authorizationCode || "",
    xaiOauthState: oauthState || "",
    xaiOauthRedirectUrl: redirectUrl || "",
    accountExportStatus: submitResult.status,
    accountExportResult: submitResult.attributes || {},
    xaiAuthFilePatchResult: submitResult.xaiAuthFilePatchResult || null
  });
}

function isDeviceOauthFlow(ctx) {
  return ctx.state?.xaiOauthFlow === "device" || isXAiDeviceOauthUrl(ctx.state?.xaiOauthUrl?.url);
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
