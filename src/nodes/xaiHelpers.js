export const XAI_SIGN_UP_URL = "https://accounts.x.ai/sign-up";
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
    const button = Array.from(document.querySelectorAll("button"))
      .find((item) => {
        const text = String(item.textContent || "").trim().toLowerCase();
        return isVisible(item)
          && normalizedKeywords.some((keyword) => keyword && text.includes(keyword));
      });
    return button ? describeButton(button) : null;

    function describeButton(element) {
      return {
        text: String(element.textContent || "").trim(),
        disabled: element.disabled,
        ariaDisabled: element.getAttribute("aria-disabled") || "",
        type: element.getAttribute("type") || "",
        name: element.getAttribute("name") || ""
      };
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
    const button = Array.from(document.querySelectorAll("button"))
      .find((item) => {
        const text = String(item.textContent || "").trim().toLowerCase();
        return isClickable(item)
          && normalizedKeywords.some((keyword) => keyword && text.includes(keyword));
      });
    if (!button) {
      return { ok: false, button: null };
    }
    button.scrollIntoView({ block: "center", inline: "center" });
    button.click();
    return {
      ok: true,
      button: {
        text: String(button.textContent || "").trim(),
        type: button.getAttribute("type") || "",
        name: button.getAttribute("name") || ""
      }
    };

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
