import { RegisterNode, NodeResult } from "../core/flow.js";
import { waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";
import { containsPageText, getPageTextTerms } from "../core/pageText.js";

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
    const submitResult = birthdayResult.mode === "birthday_to_age"
      ? await switchBirthdayModeToAgeAndSubmit(ctx, account)
      : await clickSubmitWhenReady(ctx, "资料页提交按钮可用");
    if (!submitResult.ok) {
      return NodeResult.fail("about_you_failed", submitResult.error || "资料页提交按钮点击失败");
    }
    logger.info("资料页提交按钮已点击", submitResult.submitResult || submitResult);

    const result = await waitForAboutYouSubmitResult(ctx);

    const currentUrl = await ctx.tabs.getCurrentUrl();
    if (!result.matched) {
      return NodeResult.fail("about_you_unexpected_url", `资料页提交后未进入 ChatGPT: ${currentUrl}`, { currentUrl });
    }
    if (result.name === "age_confirmation_dialog_error") {
      return NodeResult.fail("about_you_age_confirm_failed", String(result.value?.error || "出生日期确认弹框提交失败"), { currentUrl });
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

async function queryTextContains(ctx, selector, pageTextName) {
  const text = await ctx.tabs.queryText(selector);
  return text && containsPageText(text, pageTextName) ? text : null;
}

async function queryAnyTextContains(ctx, selector, expectedText) {
  return ctx.tabs.execute((inputSelector, text) => {
    const elements = Array.from(document.querySelectorAll(inputSelector));
    const element = elements.find((item) => item.textContent.includes(text));
    return element ? element.textContent.trim() : null;
  }, [selector, expectedText]);
}

async function waitForAboutYouSubmitResult(ctx) {
  let ageConfirmAttempts = 0;
  while (true) {
    const result = await waitForAnyCondition([
      {
        name: "submit_error",
        check: () => queryTextContains(ctx, "ul[class^='_errors_']", "accountCreateFailed")
      },
      {
        name: "user_already_exists",
        check: () => queryAnyTextContains(ctx, "span", "user_already_exists")
      },
      {
        name: "age_confirmation_dialog",
        check: () => findAgeConfirmationDialog(ctx)
      },
      {
        name: "ready_dialog",
        check: () => findReadyDialog(ctx)
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

    if (!result.matched || result.name !== "age_confirmation_dialog") {
      return result;
    }
    ageConfirmAttempts += 1;
    if (ageConfirmAttempts > 2) {
      return {
        matched: true,
        name: "age_confirmation_dialog_error",
        value: { error: "出生日期确认弹框重复出现" }
      };
    }
    const clickResult = await clickAgeConfirmationDialog(ctx);
    if (!clickResult?.ok) {
      return {
        matched: true,
        name: "age_confirmation_dialog_error",
        value: clickResult
      };
    }
    logger.info("出生日期确认弹框已提交", clickResult);
  }
}

async function findReadyDialog(ctx) {
  return ctx.tabs.execute((terms) => {
    return Array.from(document.querySelectorAll("dialog"))
      .find((dialog) => {
        const label = String(dialog.getAttribute("aria-label") || "").toLowerCase();
        return terms.some((term) => term && label.includes(term));
      })?.getAttribute("aria-label") || null;
  }, [getPageTextTerms("chatGptReady").map((term) => term.toLowerCase())]);
}

async function findAgeConfirmationDialog(ctx) {
  return ctx.tabs.execute(() => {
    const dialog = findVisibleAgeDialogBody();
    if (!dialog) {
      return null;
    }
    const submit = dialog.querySelector("input[type='submit']");
    return {
      className: dialog.className || "",
      text: dialog.textContent.trim(),
      hasSubmit: Boolean(submit)
    };

    function findVisibleAgeDialogBody() {
      const elements = Array.from(document.querySelectorAll("div[class^='_ageDialogBody'], div[class*='_ageDialogBody']"));
      return elements.find((item) => {
        const style = window.getComputedStyle(item);
        return style.visibility !== "hidden"
          && style.display !== "none"
          && item.getClientRects().length > 0;
      }) || null;
    }
  });
}

async function clickAgeConfirmationDialog(ctx) {
  return ctx.tabs.execute(() => {
    const dialog = findVisibleAgeDialogBody();
    if (!dialog) {
      return { ok: false, error: "未找到出生日期确认弹框" };
    }
    const submit = dialog.querySelector("input[type='submit']");
    if (!submit) {
      return { ok: false, error: "出生日期确认弹框内未找到提交按钮" };
    }
    if (submit.disabled || submit.getAttribute("aria-disabled") === "true") {
      return { ok: false, error: "出生日期确认弹框提交按钮不可用" };
    }
    submit.scrollIntoView({ block: "center", inline: "center" });
    submit.click();
    return {
      ok: true,
      className: dialog.className || "",
      buttonValue: submit.value || "",
      buttonText: submit.textContent?.trim?.() || ""
    };

    function findVisibleAgeDialogBody() {
      const elements = Array.from(document.querySelectorAll("div[class^='_ageDialogBody'], div[class*='_ageDialogBody']"));
      return elements.find((item) => {
        const style = window.getComputedStyle(item);
        return style.visibility !== "hidden"
          && style.display !== "none"
          && item.getClientRects().length > 0;
      }) || null;
    }
  });
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

async function clickSubmitWhenReady(ctx, label) {
  const submitReady = await waitForAnyCondition([
    {
      name: "submit_ready",
      check: () => findClickableSubmitButton(ctx)
    }
  ], {
    timeoutMs: 10000,
    intervalMs: 300,
    label,
    signal: ctx.signal
  });
  if (!submitReady.matched) {
    return { ok: false, error: "资料页提交按钮不可用" };
  }
  const submitResult = await ctx.tabs.clickPrimarySubmitButton();
  if (!submitResult?.ok) {
    return { ok: false, error: "资料页提交按钮点击失败", submitResult };
  }
  return { ok: true, submitResult };
}

async function switchBirthdayModeToAgeAndSubmit(ctx, account) {
  logger.info("出生日期输入模式改用年龄输入：首次提交触发校验错误");
  const firstSubmit = await clickSubmitWhenReady(ctx, "出生日期页首次提交触发校验错误");
  if (!firstSubmit.ok) {
    return firstSubmit;
  }

  const firstSubmitResult = await waitForAnyCondition([
    {
      name: "age_input",
      check: () => ctx.tabs.query("input[name='age']")
    },
    {
      name: "use_birthdate_link",
      check: () => findUseBirthDateLink(ctx)
    },
    {
      name: "validation_error",
      check: () => findAboutYouValidationError(ctx)
    }
  ], {
    timeoutMs: 10000,
    intervalMs: 300,
    label: "出生日期页首次提交后的校验错误或年龄输入框",
    signal: ctx.signal
  });
  if (!firstSubmitResult.matched) {
    return { ok: false, error: "出生日期页首次提交后未出现校验错误或年龄输入框" };
  }
  logger.info("出生日期页首次提交后状态", {
    name: firstSubmitResult.name,
    value: firstSubmitResult.value
  });

  if (firstSubmitResult.name !== "age_input" && !await ctx.tabs.query("input[name='age']")) {
    logger.info("出生日期输入模式改用年龄输入：二次提交切换输入方式");
    const secondSubmit = await clickSubmitWhenReady(ctx, "出生日期页二次提交切换年龄输入");
    if (!secondSubmit.ok) {
      return secondSubmit;
    }
  }

  const ageReady = await waitForAnyCondition([
    {
      name: "age_input",
      check: () => ctx.tabs.query("input[name='age']")
    },
    {
      name: "use_birthdate_link",
      check: () => findUseBirthDateLink(ctx)
    }
  ], {
    timeoutMs: 10000,
    intervalMs: 300,
    label: "等待年龄输入框出现",
    signal: ctx.signal
  });
  if (!ageReady.matched) {
    return { ok: false, error: "二次提交后未出现年龄输入框" };
  }

  if (!await ctx.tabs.query("input[name='age']")) {
    const retryAgeReady = await waitForAnyCondition([
      {
        name: "age_input",
        check: () => ctx.tabs.query("input[name='age']")
      }
    ], {
      timeoutMs: 3000,
      intervalMs: 300,
      label: "使用出生日期链接出现后等待年龄输入框",
      signal: ctx.signal
    });
    if (!retryAgeReady.matched) {
      return { ok: false, error: "页面已切换但未找到年龄输入框" };
    }
  }

  const fillResult = await ctx.tabs.fill("input[name='age']", String(account.age));
  if (!fillResult.ok) {
    return { ok: false, error: "年龄输入框填写失败" };
  }
  logger.info("出生日期输入模式已切换为年龄输入并填写", { age: account.age });
  return clickSubmitWhenReady(ctx, "年龄输入后提交资料页");
}

async function findAboutYouValidationError(ctx) {
  return ctx.tabs.execute(() => {
    const selectors = [
      "ul[class^='_errors_']",
      "ul[class*='_errors_']",
      "[role='alert']",
      "span[slot='errorMessage']"
    ];
    for (const selector of selectors) {
      const elements = Array.from(document.querySelectorAll(selector));
      const element = elements.find((item) => {
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

async function findUseBirthDateLink(ctx) {
  return ctx.tabs.execute((terms) => {
    const links = Array.from(document.querySelectorAll("a"));
    const link = links.find((item) => {
      const text = String(item.textContent || "").toLowerCase();
      return terms.some((term) => term && text.includes(term));
    });
    return link ? {
      text: link.textContent.trim(),
      href: link.getAttribute("href") || ""
    } : null;
  }, [getPageTextTerms("useBirthDate").map((term) => term.toLowerCase())]);
}

async function fillAgeOrBirthDate(ctx, account) {
  if (await ctx.tabs.query("input[name='age']")) {
    const fillResult = await ctx.tabs.fill("input[name='age']", String(account.age));
    return fillResult.ok
      ? { ok: true, mode: "age" }
      : { ok: false, error: "年龄输入框填写失败" };
  }

  if (!await ctx.tabs.query("input[name='birthday']")) {
    return { ok: false, error: "未找到年龄输入框或生日输入框" };
  }
  logger.info("检测到出生日期输入模式，跳过生日填写，改用提交校验切换年龄输入", {
    age: account.age,
    birthDate: account.birthDate?.value || ""
  });
  return { ok: true, mode: "birthday_to_age" };
}
