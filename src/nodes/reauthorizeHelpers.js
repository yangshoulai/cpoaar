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
  return Boolean(await resolvePhoneInputSelector(ctx));
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

export function promptRequired(message) {
  const value = window.prompt(message);
  return String(value || "").trim();
}
