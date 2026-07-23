import { getPageTextTerms } from "../core/pageText.js";

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
  if (await ctx.tabs.query("input[name='code']")) {
    return "input[name='code']";
  }
  if (await ctx.tabs.query("input[name='name']")) {
    return "input[name='name']";
  }
  return "";
}

export async function findOneTimeCodeLoginButton(ctx) {
  return ctx.tabs.execute(runOneTimeCodeLoginButtonAction, ["find", getPageTextTerms("oneTimeCodeLogin")]);
}

export async function clickOneTimeCodeLoginButton(ctx) {
  return ctx.tabs.execute(runOneTimeCodeLoginButtonAction, ["click", getPageTextTerms("oneTimeCodeLogin")]);
}

export function promptRequired(message) {
  const value = window.prompt(message);
  return String(value || "").trim();
}

function runOneTimeCodeLoginButtonAction(action, inputKeywords = []) {
  const passwordInput = document.querySelector("input[name='current-password']");
  if (!passwordInput) {
    return null;
  }
  const candidates = Array.from(document.querySelectorAll('button[name="intent"]'))
    .filter((button) => !button.disabled && button.getAttribute("aria-disabled") !== "true");
  const keywords = inputKeywords.map((keyword) => String(keyword || "").toLowerCase());
  const button = candidates.find((item) => {
    const text = `${item.textContent || ""} ${item.value || ""}`.toLowerCase();
    return keywords.some((keyword) => text.includes(keyword));
  }) || candidates[0];
  if (!button) {
    return null;
  }
  const data = {
    tagName: button.tagName,
    text: button.textContent.trim(),
    value: button.value || "",
    id: button.id || "",
    name: button.getAttribute("name") || "",
    ariaLabel: button.getAttribute("aria-label") || ""
  };
  if (action === "click") {
    button.scrollIntoView({ block: "center", inline: "center" });
    button.click();
  }
  return data;
}
