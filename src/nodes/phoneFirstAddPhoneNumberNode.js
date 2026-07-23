import { RegisterNode, NodeResult } from "../core/flow.js";
import { sleep, waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";
import { containsPageText, getPageTextTerms } from "../core/pageText.js";
import { CHATGPT_PHONE_INPUT_SELECTOR, ensureChatGptPhoneInput } from "./openChatGptPhoneFirstNode.js";

const logger = createLogger("node.phone-first-phone");
const WHATSAPP_DEFAULT_NOTICE_WAIT_MS = 1500;

export class PhoneFirstAddPhoneNumberNode extends RegisterNode {
  static name = "phone_first_add_phone_number";
  static statuses = {
    success: "phone_first_phone_submitted"
  };

  constructor() {
    super(PhoneFirstAddPhoneNumberNode.name, "填写手机号");
  }

  async execute(ctx) {
    if (!ctx.services.smsService) {
      return NodeResult.fail("sms_service_not_configured", "未配置短信服务");
    }

    const maxAttempts = Number(ctx.config.register.phoneNumberRetryAttempts ?? 1);
    let retryCount = 0;
    while (true) {
      const result = await this._submitOneMobile(ctx);
      if (
        result.status === "phone_submit_error"
        && result.error
        && (result.data?.retryablePhoneNumber || containsPageText(result.error, "phoneRetryableError"))
        && retryCount < maxAttempts
      ) {
        retryCount += 1;
        logger.warn("手机优先注册手机号不可用，重新获取手机号重试", {
          error: result.error,
          retryCount,
          maxAttempts
        });
        const resetResult = await resetToPhoneFirstEntry(ctx);
        if (!resetResult.ok) {
          return NodeResult.fail("phone_first_open_failed", resetResult.error || "重试前重新打开手机注册入口失败", {
            currentUrl: await ctx.tabs.getCurrentUrl()
          });
        }
        continue;
      }
      return result;
    }
  }

  async _submitOneMobile(ctx) {
    const entryResult = await ensureChatGptPhoneInput(ctx);
    if (!entryResult.ok) {
      return NodeResult.fail("phone_first_open_failed", entryResult.error || "未能进入手机号输入页面", {
        currentUrl: await ctx.tabs.getCurrentUrl()
      });
    }

    const account = prepareAccount(ctx);
    const excluded = ctx.state.triedSmsActivationIds || [];
    const mobileNumber = await ctx.services.smsService.getMobileNumber({
      excludedActivationIds: excluded,
      signal: ctx.signal
    });
    if (!mobileNumber) {
      return NodeResult.fail("stopped", "流程已停止");
    }

    rememberTriedActivation(ctx, mobileNumber);
    account.mobile = normalizeMobile(mobileNumber.mobileNumber);
    ctx.state.smsMobileNumber = mobileNumber;
    logger.info("手机优先注册填写手机号", {
      mobile: account.mobile,
      provider: mobileNumber.attributes?.provider || ""
    });

    const fillResult = await fillPhoneFirstPhoneInput(ctx, `+${account.mobile}`);
    if (!fillResult.ok) {
      await ctx.services.smsService.callback(mobileNumber, false);
      return NodeResult.fail("phone_submit_failed", fillResult.error || "未找到手机号输入框");
    }
    logger.info("手机优先注册手机号填充完成", {
      mobile: account.mobile,
      provider: mobileNumber.attributes?.provider || "",
      value: fillResult.value || "",
      method: fillResult.method || "",
      selector: fillResult.selector || ""
    });

    const whatsappDefaultNotice = await waitForWhatsAppDefaultNotice(ctx);
    if (whatsappDefaultNotice) {
      const message = whatsappDefaultNotice.text || "我们会通过 WhatsApp 向该号码发送一次性验证码进行验证。";
      logger.warn("手机优先注册手机号默认通过 WhatsApp 发送验证码，标记号码不可用", {
        mobile: account.mobile,
        provider: mobileNumber.attributes?.provider || "",
        message
      });
      await ctx.services.smsService.callback(mobileNumber, false);
      return NodeResult.fail("phone_submit_error", message, {
        smsMobileNumber: mobileNumber,
        currentUrl: await ctx.tabs.getCurrentUrl(),
        whatsappDefaultNotice
      });
    }

    const phoneSubmittedAt = new Date().toISOString();
    ctx.state.phoneSubmittedAt = phoneSubmittedAt;
    const submitResult = await clickPhoneSubmitButton(ctx);
    if (!submitResult.ok) {
      await ctx.services.smsService.callback(mobileNumber, false);
      return NodeResult.fail("phone_submit_failed", submitResult.error || "手机号提交按钮点击失败", {
        smsMobileNumber: mobileNumber,
        phoneSubmittedAt,
        currentUrl: await ctx.tabs.getCurrentUrl()
      });
    }

    const waitResult = await waitForAnyCondition([
      {
        name: "submit_error",
        check: () => findPhoneSubmitError(ctx)
      },
      {
        name: "create_password",
        check: async () => {
          const url = await ctx.tabs.getCurrentUrl();
          if (!url.includes("/create-account/password")) {
            return null;
          }
          return ctx.tabs.query("input[name='new-password']");
        }
      },
      {
        name: "existing_account_password",
        check: () => ctx.tabs.query("input[name='current-password'], input[name='password']")
      }
    ], {
      timeoutMs: 30000,
      label: "手机优先手机号提交后的页面结果",
      signal: ctx.signal
    });

    const data = {
      smsMobileNumber: mobileNumber,
      phoneSubmittedAt,
      currentUrl: await ctx.tabs.getCurrentUrl()
    };
    if (!waitResult.matched) {
      await ctx.services.smsService.callback(mobileNumber, false);
      return NodeResult.fail("phone_submit_error", `手机号未进入创建密码页，可能已注册或不可注册: ${data.currentUrl}`, {
        ...data,
        retryablePhoneNumber: true
      });
    }
    if (waitResult.name === "submit_error") {
      await ctx.services.smsService.callback(mobileNumber, false);
      return NodeResult.fail("phone_submit_error", String(waitResult.value?.text || waitResult.value || "手机号提交失败"), data);
    }
    if (waitResult.name === "existing_account_password") {
      await ctx.services.smsService.callback(mobileNumber, false);
      return NodeResult.fail("phone_submit_error", "手机号已注册或不可注册：提交后进入密码登录页", {
        ...data,
        retryablePhoneNumber: true
      });
    }
    return NodeResult.ok(PhoneFirstAddPhoneNumberNode.statuses.success, data);
  }
}

function prepareAccount(ctx) {
  if (ctx.state.account) {
    return ctx.state.account;
  }
  const account = ctx.services.accountService.createAccount();
  ctx.state.account = account;
  logger.info("手机优先注册账号资料已生成", {
    name: account.name,
    age: account.age,
    birthDate: account.birthDate?.value || ""
  });
  return account;
}

async function fillPhoneFirstPhoneInput(ctx, fullMobileNumber) {
  const result = await ctx.tabs.execute(async (expectedValue, primarySelector) => {
    const expectedDigits = normalizeDigits(expectedValue);
    const candidates = findPhoneInputs(primarySelector);
    for (const input of candidates) {
      const methods = [
        ["paste", () => fillWithPasteEvent(input, expectedValue)],
        ["native", () => fillWithNativeSetter(input, expectedValue)],
        ["execCommand", () => fillWithExecCommand(input, expectedValue)],
        ["incremental", () => fillIncrementally(input, expectedValue)]
      ];
      for (const [method, fill] of methods) {
        await fill();
        await sleep(350);
        const currentValue = input.value || "";
        if (isAcceptablePhoneValue(currentValue, expectedDigits)) {
          return {
            ok: true,
            value: currentValue,
            method,
            selector: describeInput(input)
          };
        }
      }
    }
    return {
      ok: false,
      value: candidates[0]?.value || "",
      method: "",
      selector: candidates[0] ? describeInput(candidates[0]) : "",
      error: candidates.length
        ? "手机号输入框未能填入，请检查页面电话输入组件"
        : "未找到可见手机号输入框"
    };

    function findPhoneInputs(selector) {
      const selectors = [
        selector,
        "input[name='phoneNumberInput']",
        "input[type='tel']",
        "input[autocomplete='tel']",
        "input[id='tel']",
        "input[id='input']"
      ];
      return [...new Set(selectors.flatMap((item) => Array.from(document.querySelectorAll(item))))]
        .filter((element) => element instanceof HTMLInputElement)
        .filter(isEditableVisibleInput);
    }

    function isEditableVisibleInput(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const type = (element.getAttribute("type") || "text").toLowerCase();
      return !element.disabled
        && !element.readOnly
        && type !== "hidden"
        && style.visibility !== "hidden"
        && style.display !== "none"
        && rect.width > 0
        && rect.height > 0;
    }

    async function fillWithPasteEvent(input, value) {
      input.scrollIntoView({ block: "center", inline: "center" });
      input.focus();
      selectAll(input);
      setNativeValue(input, "");
      dispatchTextEvents(input, "", "deleteContentBackward");

      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", value);
      input.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData
      }));
      await sleep(80);

      if (!isAcceptablePhoneValue(input.value || "", expectedDigits)) {
        document.execCommand?.("insertText", false, value);
        dispatchTextEvents(input, value, "insertFromPaste");
      }
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function fillWithNativeSetter(input, value) {
      input.scrollIntoView({ block: "center", inline: "center" });
      input.focus();
      selectAll(input);
      setNativeValue(input, "");
      dispatchTextEvents(input, "", "deleteContentBackward");
      setNativeValue(input, value);
      dispatchKeyboardEvents(input, value);
      dispatchTextEvents(input, value, "insertText");
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function fillWithExecCommand(input, value) {
      input.scrollIntoView({ block: "center", inline: "center" });
      input.focus();
      selectAll(input);
      document.execCommand?.("delete", false);
      document.execCommand?.("insertText", false, value);
      dispatchTextEvents(input, value, "insertText");
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function fillIncrementally(input, value) {
      input.scrollIntoView({ block: "center", inline: "center" });
      input.focus();
      selectAll(input);
      setNativeValue(input, "");
      dispatchTextEvents(input, "", "deleteContentBackward");
      let currentValue = "";
      for (const char of String(value)) {
        currentValue += char;
        setNativeValue(input, currentValue);
        input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: char }));
        dispatchTextEvents(input, char, "insertText");
        input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: char }));
      }
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function setNativeValue(input, value) {
      const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      if (valueSetter) {
        valueSetter.call(input, value);
      } else {
        input.value = value;
      }
    }

    function selectAll(input) {
      try {
        input.setSelectionRange(0, input.value.length);
      } catch {
        input.select?.();
      }
    }

    function dispatchKeyboardEvents(input, value) {
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: String(value).slice(-1) || "" }));
      input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: String(value).slice(-1) || "" }));
    }

    function dispatchTextEvents(input, data, inputType) {
      input.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data,
        inputType
      }));
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data,
        inputType
      }));
    }

    function isAcceptablePhoneValue(value, expected) {
      const digits = normalizeDigits(value);
      if (!digits || digits.length < Math.min(6, expected.length)) {
        return false;
      }
      return digits === expected
        || digits.endsWith(expected)
        || expected.endsWith(digits)
        || digits.includes(expected)
        || expected.includes(digits)
        || digits.length >= Math.min(8, expected.length);
    }

    function normalizeDigits(value) {
      return String(value || "").replace(/\D/g, "");
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function describeInput(input) {
      const parts = [];
      if (input.name) {
        parts.push(`name=${input.name}`);
      }
      if (input.id) {
        parts.push(`id=${input.id}`);
      }
      if (input.type) {
        parts.push(`type=${input.type}`);
      }
      if (input.placeholder) {
        parts.push(`placeholder=${input.placeholder}`);
      }
      return parts.join(" ");
    }
  }, [fullMobileNumber, CHATGPT_PHONE_INPUT_SELECTOR]);
  return result || {
    ok: false,
    value: "",
    error: "手机号输入脚本未返回结果"
  };
}

async function resetToPhoneFirstEntry(ctx) {
  return ensureChatGptPhoneInput(ctx, { navigateHome: true });
}

async function clickPhoneSubmitButton(ctx) {
  if (await ctx.tabs.query("button[type='submit']")) {
    const clicked = await ctx.tabs.click("button[type='submit']");
    if (clicked) {
      return { ok: true };
    }
  }
  const result = await ctx.tabs.clickPrimarySubmitButton();
  return result?.ok
    ? { ok: true }
    : { ok: false, error: "未找到手机号提交按钮" };
}

async function findPhoneSubmitError(ctx) {
  return ctx.tabs.execute(() => {
    const selectors = [
      "ul[class^='_errors_']",
      "ul[class*='_errors_']",
      "[role='alert']",
      "span[slot='errorMessage']"
    ];
    for (const selector of selectors) {
      const element = Array.from(document.querySelectorAll(selector)).find((item) => {
        const style = window.getComputedStyle(item);
        return style.visibility !== "hidden"
          && style.display !== "none"
          && item.textContent.trim();
      });
      if (element) {
        return {
          selector,
          text: element.textContent.trim()
        };
      }
    }
    return null;
  });
}

async function waitForWhatsAppDefaultNotice(ctx) {
  const deadline = Date.now() + WHATSAPP_DEFAULT_NOTICE_WAIT_MS;
  while (Date.now() <= deadline) {
    if (ctx.signal?.aborted) {
      return null;
    }
    const notice = await detectWhatsAppDefaultNotice(ctx);
    if (notice) {
      return notice;
    }
    await sleep(250, ctx.signal);
  }
  return null;
}

async function detectWhatsAppDefaultNotice(ctx) {
  return ctx.tabs.execute((keywords) => {
    const visibleText = String(document.body?.innerText || "")
      .replace(/\s+/g, " ")
      .trim();
    const normalized = visibleText.toLowerCase();
    const matched = keywords.find((keyword) => normalized.includes(keyword));
    if (!matched) {
      return null;
    }
    return {
      text: extractNoticeText(visibleText, matched),
      matchedKeyword: matched
    };

    function extractNoticeText(text, keyword) {
      const lowerText = text.toLowerCase();
      const index = lowerText.indexOf(keyword);
      if (index < 0) {
        return text.slice(0, 240);
      }
      const start = Math.max(0, index - 80);
      const end = Math.min(text.length, index + keyword.length + 120);
      return text.slice(start, end).trim();
    }
  }, [getPageTextTerms("whatsAppCodeNotice").map((term) => term.toLowerCase())]);
}

function rememberTriedActivation(ctx, mobileNumber) {
  const activationId = mobileNumber.attributes?.activationId;
  if (!activationId) {
    return;
  }
  const current = new Set(ctx.state.triedSmsActivationIds || []);
  current.add(String(activationId));
  ctx.state.triedSmsActivationIds = [...current];
}

function normalizeMobile(mobile) {
  return String(mobile || "").trim().replace(/^\+/, "");
}
