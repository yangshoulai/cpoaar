import { getPageTextTerms } from "../core/pageText.js";

export const EMAIL_VERIFICATION_CODE_INPUT_SELECTOR = [
  "input[name='code']",
  "input[type='code']",
  "input[autocomplete='one-time-code']",
  "input[placeholder='Code']",
  "input[aria-label='Code']"
].join(", ");

export async function findAccountDeactivatedMessage(ctx) {
  return ctx.tabs.execute(() => {
    const element = Array.from(document.querySelectorAll("span"))
      .find((item) => item.textContent.includes("account_deactivated"));
    return element ? element.textContent.trim() : null;
  });
}

export async function hasPhoneChallenge(ctx) {
  if (await ctx.tabs.urlContains("/add-phone")) {
    return true;
  }
  if (await isPhoneOtpSelectChannelPage(ctx)) {
    return true;
  }
  if (await isPhoneVerificationCodePage(ctx)) {
    return true;
  }
  return Boolean(await resolvePhoneInputSelector(ctx));
}

export async function isPhoneOtpSelectChannelPage(ctx) {
  if (!await ctx.tabs.urlContains("/phone-otp/select-channel")) {
    return false;
  }
  return Boolean(await ctx.tabs.execute((keywords) => {
    const text = String(document.body?.textContent || "").toLowerCase();
    return keywords.some((keyword) => keyword && text.includes(keyword));
  }, [getPageTextTerms("phoneOtpSelectChannel").map((term) => term.toLowerCase())]));
}

export async function isPhoneVerificationCodePage(ctx) {
  if (!await ctx.tabs.urlContains("/phone-verification")) {
    return false;
  }
  return Boolean(await ctx.tabs.execute((keywords) => {
    const text = String(document.body?.textContent || "").toLowerCase();
    const hasPhonePrompt = keywords.some((keyword) => keyword && text.includes(keyword));
    return hasPhonePrompt && Boolean(document.querySelector("input[name='code']"));
  }, [getPageTextTerms("phoneVerificationPrompt").map((term) => term.toLowerCase())]));
}

export async function resolvePhoneInputSelector(ctx) {
  if (await ctx.tabs.query("input[id='tel']")) {
    return "input[id='tel']";
  }
  if (await ctx.tabs.query("input[id='input']")) {
    return "input[id='input']";
  }
  if (await ctx.tabs.query("input[type='tel']")) {
    return "input[type='tel']";
  }
  return "";
}

export async function resolveVerificationCodeInputSelector(ctx) {
  const emailCodeInput = await findEmailVerificationCodeInput(ctx);
  if (emailCodeInput?.selector) {
    return emailCodeInput.selector;
  }
  if (await ctx.tabs.query("input[name='name']")) {
    return "input[name='name']";
  }
  return "";
}

export async function findEmailVerificationCodeInput(ctx) {
  return ctx.tabs.execute(runFindEmailVerificationCodeInput, [EMAIL_VERIFICATION_CODE_INPUT_SELECTOR.split(", ")]);
}

export async function findOneTimeCodeLoginButton(ctx) {
  return ctx.tabs.execute(runOneTimeCodeLoginButtonAction, ["find", getPageTextTerms("oneTimeCodeLogin"), EMAIL_VERIFICATION_CODE_INPUT_SELECTOR.split(", ")]);
}

export async function clickOneTimeCodeLoginButton(ctx) {
  return ctx.tabs.execute(runOneTimeCodeLoginButtonAction, ["click", getPageTextTerms("oneTimeCodeLogin"), EMAIL_VERIFICATION_CODE_INPUT_SELECTOR.split(", ")]);
}

export function promptRequired(message) {
  const value = window.prompt(message);
  return String(value || "").trim();
}

export function runFindEmailVerificationCodeInput(inputSelectors = []) {
  for (const selector of inputSelectors) {
    const input = document.querySelector(selector);
    if (input && isVisible(input)) {
      return describeElement(input, { selector });
    }
  }
  return null;

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden"
      && style.display !== "none"
      && element.getClientRects().length > 0;
  }

  function describeElement(element, extra = {}) {
    return {
      ...extra,
      tagName: element.tagName,
      text: element.textContent.trim(),
      value: element.value || "",
      id: element.id || "",
      name: element.getAttribute("name") || "",
      ariaLabel: element.getAttribute("aria-label") || ""
    };
  }
}

export function runOneTimeCodeLoginButtonAction(action, inputKeywords = [], codeInputSelectors = []) {
  const codeInput = action === "click" ? findVisibleCodeInput() : null;
  if (codeInput) {
    return {
      state: "code_input",
      codeInput: describeElement(codeInput.input, { selector: codeInput.selector })
    };
  }

  const passwordInput = document.querySelector("input[name='current-password']");
  if (!passwordInput) {
    return null;
  }
  const candidates = Array.from(document.querySelectorAll('button[name="intent"]'))
    .filter((button) => isVisible(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true");
  const keywords = inputKeywords.map((keyword) => String(keyword || "").toLowerCase());
  const button = candidates.find((item) => {
    const text = `${item.textContent || ""} ${item.value || ""}`.toLowerCase();
    return keywords.some((keyword) => text.includes(keyword));
  });
  if (!button) {
    return null;
  }
  const data = describeElement(button);
  if (action === "click") {
    button.scrollIntoView({ block: "center", inline: "center" });
    button.click();
    return { state: "clicked", button: data };
  }
  return data;

  function findVisibleCodeInput() {
    for (const selector of codeInputSelectors) {
      const input = document.querySelector(selector);
      if (input && isVisible(input)) {
        return { input, selector };
      }
    }
    return null;
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden"
      && style.display !== "none"
      && element.getClientRects().length > 0;
  }

  function describeElement(element, extra = {}) {
    return {
      ...extra,
      tagName: element.tagName,
      text: element.textContent.trim(),
      value: element.value || "",
      id: element.id || "",
      name: element.getAttribute("name") || "",
      ariaLabel: element.getAttribute("aria-label") || ""
    };
  }
}
