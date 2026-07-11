export const XAI_SIGN_UP_URL = "https://accounts.x.ai/sign-up";
export const XAI_SIGN_IN_URL = "https://accounts.x.ai/sign-in?email=true";
export const XAI_CALLBACK_URL_PREFIX = "http://127.0.0.1:56121/callback";

export function normalizeXAiVerificationCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function buildXAiRedirectUrl(code, state = "") {
  const url = new URL(XAI_CALLBACK_URL_PREFIX);
  url.searchParams.set("code", String(code || "").trim());
  if (state) {
    url.searchParams.set("state", String(state).trim());
  }
  return url.toString();
}

export async function findVisibleButtonByText(ctx, keywords) {
  return ctx.tabs.execute((inputKeywords) => {
    const normalizedKeywords = inputKeywords.map((item) => String(item || "").toLowerCase());
    const button = findBestButton({
      keywords: normalizedKeywords,
      clickableOnly: false
    });
    return button ? describeButton(button) : null;

    function describeButton(element) {
      return {
        text: String(element.textContent || "").trim(),
        disabled: element.disabled,
        ariaDisabled: element.getAttribute("aria-disabled") || "",
        type: element.getAttribute("type") || "",
        name: element.getAttribute("name") || "",
        value: element.getAttribute("value") || "",
        formAction: element.form?.getAttribute("action") || "",
        formMethod: element.form?.getAttribute("method") || ""
      };
    }

    function findBestButton({ keywords, clickableOnly }) {
      return Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit']"))
        .map((item) => ({ item, score: scoreButton(item, keywords, clickableOnly) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score)[0]?.item || null;
    }

    function scoreButton(element, keywords, clickableOnly) {
      if (clickableOnly ? !isClickable(element) : !isVisible(element)) {
        return 0;
      }
      const text = getButtonText(element).toLowerCase();
      if (!text || !keywords.some((keyword) => keyword && text.includes(keyword))) {
        return 0;
      }
      if (isAllowSearch(keywords) && isNegativeAllowText(text)) {
        return 0;
      }
      let score = 10;
      if (keywords.some((keyword) => keyword && text === keyword)) {
        score += 100;
      }
      const actionText = [
        element.getAttribute("name"),
        element.getAttribute("value"),
        element.getAttribute("data-action"),
        element.getAttribute("aria-label")
      ].filter(Boolean).join(" ").toLowerCase();
      if (/(allow|approve|authorize|accept|consent)/.test(actionText)) {
        score += 40;
      }
      return score;
    }

    function getButtonText(element) {
      if (element instanceof HTMLInputElement) {
        return String(element.value || element.getAttribute("aria-label") || "").trim();
      }
      return String(element.textContent || element.getAttribute("aria-label") || "").trim();
    }

    function isAllowSearch(keywords) {
      return keywords.some((keyword) => ["允许", "allow", "authorize", "approve"].includes(keyword));
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
      return isVisible(element)
        && !element.disabled
        && element.getAttribute("aria-disabled") !== "true";
    }

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      return style.visibility !== "hidden"
        && style.display !== "none"
        && element.getClientRects().length > 0;
    }
  }, [keywords]);
}

export async function clickVisibleButtonByText(ctx, keywords) {
  return ctx.tabs.execute((inputKeywords) => {
    const normalizedKeywords = inputKeywords.map((item) => String(item || "").toLowerCase());
    const button = findBestButton({
      keywords: normalizedKeywords,
      clickableOnly: true
    });
    if (!button) {
      return { ok: false, button: null };
    }
    button.scrollIntoView({ block: "center", inline: "center" });
    button.click();
    return {
      ok: true,
      button: {
        text: getButtonText(button),
        type: button.getAttribute("type") || "",
        name: button.getAttribute("name") || "",
        value: button.getAttribute("value") || "",
        formAction: button.form?.getAttribute("action") || "",
        formMethod: button.form?.getAttribute("method") || ""
      }
    };

    function findBestButton({ keywords, clickableOnly }) {
      return Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit']"))
        .map((item) => ({ item, score: scoreButton(item, keywords, clickableOnly) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score)[0]?.item || null;
    }

    function scoreButton(element, keywords, clickableOnly) {
      if (clickableOnly ? !isClickable(element) : !isVisible(element)) {
        return 0;
      }
      const text = getButtonText(element).toLowerCase();
      if (!text || !keywords.some((keyword) => keyword && text.includes(keyword))) {
        return 0;
      }
      if (isAllowSearch(keywords) && isNegativeAllowText(text)) {
        return 0;
      }
      let score = 10;
      if (keywords.some((keyword) => keyword && text === keyword)) {
        score += 100;
      }
      const actionText = [
        element.getAttribute("name"),
        element.getAttribute("value"),
        element.getAttribute("data-action"),
        element.getAttribute("aria-label")
      ].filter(Boolean).join(" ").toLowerCase();
      if (/(allow|approve|authorize|accept|consent)/.test(actionText)) {
        score += 40;
      }
      return score;
    }

    function getButtonText(element) {
      if (element instanceof HTMLInputElement) {
        return String(element.value || element.getAttribute("aria-label") || "").trim();
      }
      return String(element.textContent || element.getAttribute("aria-label") || "").trim();
    }

    function isAllowSearch(keywords) {
      return keywords.some((keyword) => ["允许", "allow", "authorize", "approve"].includes(keyword));
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
  }, [keywords]);
}

export async function getReadonlyAuthorizationCode(ctx) {
  return ctx.tabs.execute(() => {
    const input = Array.from(document.querySelectorAll("input[type='text'], input:not([type])"))
      .find((item) => (
        item.disabled
        && item.readOnly
        && String(item.value || "").trim()
        && isVisible(item)
      ));
    return input ? String(input.value || "").trim() : "";

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      return style.visibility !== "hidden"
        && style.display !== "none"
        && element.getClientRects().length > 0;
    }
  });
}
