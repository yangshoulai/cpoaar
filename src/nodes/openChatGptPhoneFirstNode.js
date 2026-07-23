import { RegisterNode, NodeResult } from "../core/flow.js";
import { waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";
import { getPageTextTerms } from "../core/pageText.js";

const logger = createLogger("node.open-phone-first");
const CHATGPT_HOME_URL = "https://chatgpt.com/";
export const CHATGPT_PHONE_INPUT_SELECTOR = "input[name='phoneNumberInput']";
const SIGNUP_BUTTON_SELECTOR = "button[data-testid='signup-button']";

export class OpenChatGptPhoneFirstNode extends RegisterNode {
  static name = "open_chatgpt_phone_first";
  static statuses = {
    success: "chatgpt_phone_first_opened"
  };

  constructor() {
    super(OpenChatGptPhoneFirstNode.name, "打开 ChatGPT");
  }

  async execute(ctx) {
    await ctx.tabs.navigate(CHATGPT_HOME_URL);
    const waitResult = await waitForPhoneSignupEntry(ctx);

    const currentUrl = await ctx.tabs.getCurrentUrl();
    if (!isTargetChatGptUrl(currentUrl)) {
      return NodeResult.fail("phone_first_open_failed", `当前地址不是 ChatGPT 目标地址: ${currentUrl}`);
    }
    if (!waitResult.matched) {
      return NodeResult.fail("phone_first_open_failed", `未找到 ChatGPT 注册按钮或手机号注册入口: ${currentUrl}`);
    }

    logger.info("ChatGPT 手机注册入口已就绪", {
      entry: waitResult.name,
      currentUrl
    });
    return NodeResult.ok(OpenChatGptPhoneFirstNode.statuses.success, {
      currentUrl
    });
  }
}

export async function ensureChatGptPhoneInput(ctx, { navigateHome = false } = {}) {
  if (navigateHome) {
    await ctx.tabs.navigate(CHATGPT_HOME_URL);
  }

  const currentPageResult = await ensurePhoneInputOnCurrentPage(ctx);
  if (currentPageResult.ok) {
    return currentPageResult;
  }

  logger.info("当前页面没有手机号输入框或手机号注册入口，重新打开 ChatGPT 注册入口", {
    currentUrl: await ctx.tabs.getCurrentUrl(),
    error: currentPageResult.error || ""
  });
  await ctx.tabs.navigate(CHATGPT_HOME_URL);
  return ensurePhoneInputOnCurrentPage(ctx);
}

async function ensurePhoneInputOnCurrentPage(ctx) {
  if (await ctx.tabs.query(CHATGPT_PHONE_INPUT_SELECTOR)) {
    return { ok: true, entry: "phone_input" };
  }

  const existedPhoneButton = await findPhoneContinueButton(ctx);
  if (existedPhoneButton) {
    logger.info("找到“使用电话号码继续”按钮，点击进入手机号输入", {
      text: existedPhoneButton.text
    });
    return clickPhoneContinueAndWaitInput(ctx);
  }

  const signupButton = await findSignupButton(ctx);
  if (!signupButton) {
    return { ok: false, error: `未找到注册按钮或手机号入口: ${await ctx.tabs.getCurrentUrl()}` };
  }

  logger.info("手机号输入框未出现，点击注册按钮", {
    text: signupButton.text,
    testId: signupButton.testId
  });
  const clickedSignup = await clickSignupButton(ctx);
  if (!clickedSignup) {
    return { ok: false, error: "注册按钮点击失败" };
  }

  const dialog = await waitForAnyCondition([
    {
      name: "phone_input",
      check: () => ctx.tabs.query(CHATGPT_PHONE_INPUT_SELECTOR)
    },
    {
      name: "phone_continue_button",
      check: () => findPhoneContinueButton(ctx)
    }
  ], {
    timeoutMs: 15000,
    intervalMs: 300,
    label: "点击注册按钮后等待手机号入口",
    signal: ctx.signal
  });
  if (!dialog.matched) {
    return { ok: false, error: `点击注册按钮后未出现手机号入口: ${await ctx.tabs.getCurrentUrl()}` };
  }
  if (dialog.name === "phone_input") {
    return { ok: true, entry: dialog.name };
  }
  return clickPhoneContinueAndWaitInput(ctx);
}

async function clickPhoneContinueAndWaitInput(ctx) {
  const clickedPhone = await clickPhoneContinueButton(ctx);
  if (!clickedPhone) {
    return { ok: false, error: "未能点击“使用电话号码继续”按钮" };
  }

  const phoneInput = await waitForAnyCondition([
    {
      name: "phone_input",
      check: () => ctx.tabs.query(CHATGPT_PHONE_INPUT_SELECTOR)
    }
  ], {
    timeoutMs: 15000,
    intervalMs: 300,
    label: "点击使用电话号码继续后等待手机号输入框",
    signal: ctx.signal
  });
  if (!phoneInput.matched) {
    return { ok: false, error: `点击“使用电话号码继续”后未出现手机号输入框: ${await ctx.tabs.getCurrentUrl()}` };
  }
  return { ok: true, entry: "phone_continue_button" };
}

async function waitForPhoneSignupEntry(ctx) {
  return waitForAnyCondition([
    {
      name: "phone_input",
      check: () => ctx.tabs.query(CHATGPT_PHONE_INPUT_SELECTOR)
    },
    {
      name: "phone_continue_button",
      check: () => findPhoneContinueButton(ctx)
    },
    {
      name: "signup_button",
      check: () => findSignupButton(ctx)
    }
  ], {
    timeoutMs: 30000,
    label: "打开 ChatGPT 后等待手机注册入口",
    signal: ctx.signal
  });
}

async function findSignupButton(ctx) {
  return await ctx.tabs.query(SIGNUP_BUTTON_SELECTOR) || ctx.tabs.findSignupButton();
}

async function clickSignupButton(ctx) {
  if (await ctx.tabs.query(SIGNUP_BUTTON_SELECTOR)) {
    const clicked = await clickSelectorRobustly(ctx, SIGNUP_BUTTON_SELECTOR);
    if (clicked) {
      return true;
    }
  }
  const result = await ctx.tabs.clickSignupButton();
  return Boolean(result?.ok);
}

async function findPhoneContinueButton(ctx) {
  return ctx.tabs.execute((keywords) => {
    const button = findButton();
    return button ? describeButton(button) : null;

    function findButton() {
      return Array.from(document.querySelectorAll("button, [role='button'], a"))
        .find((item) => isPhoneContinueElement(item)) || null;
    }

    function isPhoneContinueElement(element) {
      if (!isVisible(element) || isDisabled(element)) {
        return false;
      }
      const text = getElementText(element).toLowerCase().replace(/\s+/g, " ").trim();
      if (!text) {
        return false;
      }
      return keywords.some((keyword) => keyword && text.includes(keyword));
    }

    function describeButton(button) {
      return {
        tagName: button.tagName,
        text: getElementText(button),
        id: button.id || "",
        name: button.getAttribute("name") || "",
        type: button.getAttribute("type") || "",
        ariaLabel: button.getAttribute("aria-label") || ""
      };
    }

    function getElementText(element) {
      return String(element.textContent || element.getAttribute("aria-label") || "").trim();
    }

    function isDisabled(element) {
      return Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true";
    }

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      return style.visibility !== "hidden"
        && style.display !== "none"
        && element.getClientRects().length > 0;
    }
  }, [getPageTextTerms("phoneContinue").map((term) => term.toLowerCase())]);
}

async function clickPhoneContinueButton(ctx) {
  return ctx.tabs.execute((keywords) => {
    const button = findButton();
    if (!button) {
      return false;
    }
    clickElement(button);
    return true;

    function findButton() {
      return Array.from(document.querySelectorAll("button, [role='button'], a"))
        .find((item) => isPhoneContinueElement(item)) || null;
    }

    function isPhoneContinueElement(element) {
      if (!isVisible(element) || isDisabled(element)) {
        return false;
      }
      const text = String(element.textContent || element.getAttribute("aria-label") || "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
      if (!text) {
        return false;
      }
      return keywords.some((keyword) => keyword && text.includes(keyword));
    }

    function clickElement(element) {
      element.scrollIntoView({ block: "center", inline: "center" });
      element.focus?.();
      for (const eventType of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        element.dispatchEvent(new MouseEvent(eventType, {
          bubbles: true,
          cancelable: true,
          view: window
        }));
      }
    }

    function isDisabled(element) {
      return Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true";
    }

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      return style.visibility !== "hidden"
        && style.display !== "none"
        && element.getClientRects().length > 0;
    }
  }, [getPageTextTerms("phoneContinue").map((term) => term.toLowerCase())]);
}

async function clickSelectorRobustly(ctx, selector) {
  return ctx.tabs.execute((inputSelector) => {
    const element = document.querySelector(inputSelector);
    if (!element) {
      return false;
    }
    element.scrollIntoView({ block: "center", inline: "center" });
    element.focus?.();
    for (const eventType of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      element.dispatchEvent(new MouseEvent(eventType, {
        bubbles: true,
        cancelable: true,
        view: window
      }));
    }
    return true;
  }, [selector]);
}

function isTargetChatGptUrl(url) {
  try {
    return new URL(url).hostname === "chatgpt.com";
  } catch {
    return false;
  }
}
