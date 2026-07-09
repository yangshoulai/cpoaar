import { RegisterNode, NodeResult } from "../core/flow.js";
import { waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";

const logger = createLogger("node.about-you");

export class FillAboutYouNode extends RegisterNode {
  static name = "fill_about_you";
  static statuses = {
    success: "about_you_submitted",
    retryFillEmail: "about_you_retry_fill_email"
  };

  constructor() {
    super(FillAboutYouNode.name, "填写资料");
  }

  async execute(ctx) {
    const account = ctx.state.account;
    if (!account) {
      return NodeResult.fail("about_you_failed", "上下文缺少账号信息");
    }
    logger.info("填写姓名和年龄/生日", {
      name: account.name,
      age: account.age,
      birthDate: account.birthDate?.value || ""
    });
    const nameResult = await ctx.tabs.fill("input[name='name']", account.name);
    if (!nameResult.ok) {
      return NodeResult.fail("about_you_failed", "未找到姓名输入框");
    }
    const birthdayResult = await fillAgeOrBirthDate(ctx, account);
    if (!birthdayResult.ok) {
      return NodeResult.fail("about_you_failed", birthdayResult.error);
    }
    const submitReady = await waitForAnyCondition([
      {
        name: "submit_ready",
        check: () => findClickableSubmitButton(ctx)
      }
    ], {
      timeoutMs: 10000,
      intervalMs: 300,
      label: "资料页提交按钮可用",
      signal: ctx.signal
    });
    if (!submitReady.matched) {
      return NodeResult.fail("about_you_failed", "资料页提交按钮不可用");
    }
    const submitResult = await ctx.tabs.clickPrimarySubmitButton();
    if (!submitResult?.ok) {
      return NodeResult.fail("about_you_failed", "资料页提交按钮点击失败");
    }
    logger.info("资料页提交按钮已点击");

    const result = await waitForAnyCondition([
      {
        name: "submit_error",
        check: () => queryTextContains(ctx, "ul[class^='_errors_']", "无法创建你的帐户")
      },
      {
        name: "user_already_exists",
        check: () => queryAnyTextContains(ctx, "span", "user_already_exists")
      },
      {
        name: "ready_dialog",
        check: () => ctx.tabs.query("dialog[aria-label*='你已准备就绪']")
      },
      {
        name: "chatgpt_dialog",
        check: () => ctx.tabs.query("dialog[aria-label*='ChatGPT']")
      },
      {
        name: "profile_button",
        check: () => ctx.tabs.query("div[data-testid='accounts-profile-button']")
      }
    ], {
      timeoutMs: 30000,
      label: "资料页提交后的页面结果",
      signal: ctx.signal
    });

    const currentUrl = await ctx.tabs.getCurrentUrl();
    if (!result.matched) {
      return NodeResult.fail("about_you_unexpected_url", `资料页提交后未进入 ChatGPT: ${currentUrl}`, { currentUrl });
    }
    if (result.name === "submit_error") {
      return NodeResult.fail("account_create_failed", String(result.value), { currentUrl });
    }
    if (result.name === "user_already_exists") {
      logger.warn("资料页提交后账号已存在，回退到填写邮箱节点", {
        currentUrl,
        message: String(result.value || "")
      });
      return NodeResult.ok(FillAboutYouNode.statuses.retryFillEmail, {
        currentUrl,
        reuseGeneratedEmailForLogin: true
      });
    }
    return NodeResult.ok(FillAboutYouNode.statuses.success, { currentUrl });
  }
}

async function queryTextContains(ctx, selector, expectedText) {
  const text = await ctx.tabs.queryText(selector);
  return text && text.includes(expectedText) ? text : null;
}

async function queryAnyTextContains(ctx, selector, expectedText) {
  return ctx.tabs.execute((inputSelector, text) => {
    const elements = Array.from(document.querySelectorAll(inputSelector));
    const element = elements.find((item) => item.textContent.includes(text));
    return element ? element.textContent.trim() : null;
  }, [selector, expectedText]);
}

async function findClickableSubmitButton(ctx) {
  return ctx.tabs.execute(() => {
    const buttons = Array.from(document.querySelectorAll("button[type='submit']"));
    const button = buttons.find((item) => {
      const style = window.getComputedStyle(item);
      return style.visibility !== "hidden"
        && style.display !== "none"
        && item.getClientRects().length > 0
        && !item.disabled
        && item.getAttribute("aria-disabled") !== "true";
    });
    return button ? {
      text: button.textContent.trim(),
      disabled: button.disabled,
      ariaDisabled: button.getAttribute("aria-disabled") || ""
    } : null;
  });
}

async function fillAgeOrBirthDate(ctx, account) {
  if (await ctx.tabs.query("input[name='age']")) {
    const fillResult = await ctx.tabs.fill("input[name='age']", String(account.age));
    return fillResult.ok
      ? { ok: true }
      : { ok: false, error: "年龄输入框填写失败" };
  }

  if (!await ctx.tabs.query("input[name='birthday']")) {
    return { ok: false, error: "未找到年龄输入框或生日输入框" };
  }
  const birthDate = normalizeBirthDate(account);
  logger.info("填写出生日期", birthDate);
  const fillResult = await ctx.tabs.setBirthdayInputValue(birthDate.value);
  return fillResult.ok && fillResult.value === birthDate.value
    ? { ok: true }
    : { ok: false, error: `生日输入框填写失败: value=${fillResult.value || ""}` };
}

function normalizeBirthDate(account) {
  if (account.birthDate?.value) {
    return {
      year: account.birthDate.year || account.birthDate.value.slice(0, 4),
      month: account.birthDate.month || account.birthDate.value.slice(5, 7),
      day: account.birthDate.day || account.birthDate.value.slice(8, 10),
      value: account.birthDate.value
    };
  }
  if (account.birthDate?.year && account.birthDate?.month && account.birthDate?.day) {
    const year = String(account.birthDate.year).padStart(4, "0");
    const month = String(account.birthDate.month).padStart(2, "0");
    const day = String(account.birthDate.day).padStart(2, "0");
    return {
      year,
      month,
      day,
      value: `${year}-${month}-${day}`
    };
  }
  const year = String(new Date().getFullYear() - Number(account.age || 21));
  return {
    year,
    month: "07",
    day: "02",
    value: `${year}-07-02`
  };
}
