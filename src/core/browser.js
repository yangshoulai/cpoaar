import { createLogger } from "./logger.js";
import { getPageTextTerms } from "./pageText.js";

const logger = createLogger("browser");

export class TabController {
  constructor() {
    this.currentTabId = null;
  }

  async resetOpenAiSession() {
    logger.info("清理 OpenAI/ChatGPT Cookie、相关标签页和 OAuth 本地回调页");
    await clearCookiesForDomains(["chatgpt.com", "openai.com", "auth.openai.com"]);
    await closeTabsByUrlPatterns([
      "*://chatgpt.com/*",
      "*://auth.openai.com/*",
      "*://*.openai.com/*"
    ]);
    await closeLocalOauthCallbackTabs();
    this.currentTabId = null;
  }

  async resetXAiSession() {
    logger.info("清理 x.ai Cookie 并关闭相关标签页");
    const initialStoreIds = await getAllCookieStoreIds();
    await clearCookiesForBaseDomains(["x.ai"], { storeIds: initialStoreIds });
    await closeTabsByUrlPatterns([
      "*://x.ai/*",
      "*://*.x.ai/*"
    ]);
    const finalStoreIds = prioritizeCookieStoreIds(await getAllCookieStoreIds(), initialStoreIds[0]);
    await clearCookiesForBaseDomains(["x.ai"], { storeIds: finalStoreIds });
    this.currentTabId = null;
  }

  async open(url) {
    const tab = await chrome.tabs.create({ url, active: true });
    this.currentTabId = tab.id;
    logger.info("打开新标签页", { url, tabId: tab.id });
    return tab.id;
  }

  async ensureTab(url = "https://chatgpt.com/") {
    if (this.currentTabId && await tabExists(this.currentTabId)) {
      return this.currentTabId;
    }
    return this.open(url);
  }

  async setCurrentTab(tabId) {
    if (!tabId || !await tabExists(tabId)) {
      throw new Error(`标签页不存在: ${tabId}`);
    }
    this.currentTabId = tabId;
  }

  async navigate(url) {
    const tabId = await this.ensureTab();
    await chrome.tabs.update(tabId, { url, active: true });
    await this.waitForTabLoaded(tabId);
    logger.info("标签页跳转完成", { url, tabId });
    return tabId;
  }

  async reload() {
    const tabId = await this.ensureTab();
    await chrome.tabs.reload(tabId);
    await this.waitForTabLoaded(tabId);
    logger.info("标签页刷新完成", { tabId });
  }

  async getCurrentUrl() {
    const tabId = await this.ensureTab();
    const tab = await chrome.tabs.get(tabId);
    return tab.url || "";
  }

  async getCurrentUrlIfAvailable() {
    if (!this.currentTabId || !await tabExists(this.currentTabId)) {
      return "";
    }
    const tab = await chrome.tabs.get(this.currentTabId);
    return tab.url || "";
  }

  async getXAiSsoCookie() {
    return getXAiSsoCookie(await this.getCurrentCookieStoreId());
  }

  async ensureXAiSsoCookieForAuthHosts(value, preferredStoreId = "") {
    return ensureXAiSsoCookieForAuthHosts(value, preferredStoreId || await this.getCurrentCookieStoreId());
  }

  async getCurrentCookieStoreId() {
    if (!this.currentTabId || !await tabExists(this.currentTabId)) {
      return "";
    }
    return getCookieStoreIdForTab(this.currentTabId);
  }

  async waitForTabLoaded(tabId = this.currentTabId, timeoutMs = 30000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") {
        return;
      }
      await sleep(250);
    }
    throw new Error(`等待标签页加载超时: ${tabId}`);
  }

  async query(selector) {
    return this.execute((inputSelector) => {
      const element = document.querySelector(inputSelector);
      if (!element) {
        return null;
      }
      return {
        tagName: element.tagName,
        text: element.textContent.trim(),
        value: element.value || "",
        id: element.id || "",
        name: element.getAttribute("name") || "",
        ariaLabel: element.getAttribute("aria-label") || ""
      };
    }, [selector]);
  }

  async findEmailInput() {
    return this.execute(runBrowserPageAction, ["findEmailInput", null, null, getBrowserPageTextOptions()]);
  }

  async fillEmailInput(value) {
    return this.execute(runBrowserPageAction, ["fillEmailInput", value, null, getBrowserPageTextOptions()]);
  }

  async findSignupButton() {
    return this.execute(runBrowserPageAction, ["findSignupButton", null, null, getBrowserPageTextOptions()]);
  }

  async clickSignupButton() {
    return this.execute(runBrowserPageAction, ["clickSignupButton", null, null, getBrowserPageTextOptions()]);
  }

  async clickPrimarySubmitButton() {
    return this.execute(runBrowserPageAction, ["clickPrimarySubmitButton", null, null, getBrowserPageTextOptions()]);
  }

  async queryText(selector) {
    return this.execute((inputSelector) => {
      const element = document.querySelector(inputSelector);
      return element ? element.textContent.trim() : null;
    }, [selector]);
  }

  async click(selector) {
    return this.execute((inputSelector) => {
      const element = document.querySelector(inputSelector);
      if (!element) {
        return false;
      }
      element.scrollIntoView({ block: "center", inline: "center" });
      element.click();
      return true;
    }, [selector]);
  }

  async clickFirstButtonContaining(text) {
    return this.execute((expectedText) => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const button = buttons.find((item) => item.textContent.includes(expectedText));
      if (!button) {
        return false;
      }
      button.scrollIntoView({ block: "center", inline: "center" });
      button.click();
      return true;
    }, [text]);
  }

  async fill(selector, value) {
    return this.execute(runBrowserPageAction, ["fillSelector", selector, value]);
  }

  async findAccountButton(emailAddress) {
    return this.execute((email) => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const button = buttons.find((item) => {
        if (item.textContent.includes(email)) {
          return true;
        }
        return Array.from(item.querySelectorAll("span")).some((span) => span.textContent.includes(email));
      });
      return button ? {
        tagName: button.tagName,
        text: button.textContent.trim(),
        value: button.value || "",
        id: button.id || "",
        name: button.getAttribute("name") || "",
        ariaLabel: button.getAttribute("aria-label") || ""
      } : null;
    }, [emailAddress]);
  }

  async clickAccountButton(emailAddress) {
    return this.execute((email) => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const button = buttons.find((item) => {
        if (item.textContent.includes(email)) {
          return true;
        }
        return Array.from(item.querySelectorAll("span")).some((span) => span.textContent.includes(email));
      });
      if (!button) {
        return false;
      }
      button.scrollIntoView({ block: "center", inline: "center" });
      button.click();
      return true;
    }, [emailAddress]);
  }

  async clickLabelForInputValue(value) {
    return this.execute((inputValue) => {
      const input = document.querySelector(`label > input[value="${inputValue}"]`);
      if (!input) {
        return { found: false, state: "" };
      }
      const label = input.closest("label");
      if (!label) {
        return { found: false, state: "" };
      }
      label.scrollIntoView({ block: "center", inline: "center" });
      label.click();
      return { found: true, state: label.getAttribute("data-state") || "" };
    }, [value]);
  }

  async getLabelStateForInputValue(value) {
    return this.execute((inputValue) => {
      const input = document.querySelector(`label > input[value="${inputValue}"]`);
      const label = input?.closest("label");
      return label ? label.getAttribute("data-state") || "" : null;
    }, [value]);
  }

  async getInputValue(selector) {
    return this.execute((inputSelector) => {
      const element = document.querySelector(inputSelector);
      return element ? element.value || "" : null;
    }, [selector]);
  }

  async urlContains(urlPart) {
    const currentUrl = await this.getCurrentUrl();
    return currentUrl.includes(urlPart) ? currentUrl : null;
  }

  async execute(func, args = []) {
    const tabId = await this.ensureTab();
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func,
      args
    });
    return result?.result;
  }
}

export async function waitForAnyCondition(conditions, {
  timeoutMs = 30000,
  intervalMs = 500,
  label = "condition",
  signal = null
} = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (signal?.aborted) {
      logger.info("等待条件已取消", { label });
      return {
        matched: false,
        name: "stopped",
        value: null,
        stopped: true
      };
    }
    for (const condition of conditions) {
      if (signal?.aborted) {
        logger.info("等待条件已取消", { label });
        return {
          matched: false,
          name: "stopped",
          value: null,
          stopped: true
        };
      }
      const value = await condition.check();
      if (value) {
        return {
          matched: true,
          name: condition.name,
          value
        };
      }
    }
    await sleep(intervalMs, signal);
  }
  logger.warn("等待条件超时", { label, timeoutMs });
  return {
    matched: false,
    name: "",
    value: null
  };
}

export function sleep(ms, signal = null) {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) {
      resolve();
      return;
    }
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timeoutId);
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

async function clearCookiesForDomains(domains) {
  for (const domain of domains) {
    const cookies = await chrome.cookies.getAll({ domain });
    for (const cookie of cookies) {
      const url = buildCookieUrl(cookie);
      await chrome.cookies.remove({
        url,
        name: cookie.name,
        storeId: cookie.storeId
      }).catch(() => {});
    }
  }
}

async function clearCookiesForBaseDomains(baseDomains, { storeIds = null } = {}) {
  const normalizedBaseDomains = baseDomains
    .map((domain) => normalizeCookieDomain(domain))
    .filter(Boolean);
  const targetStoreIds = storeIds
    ? prioritizeCookieStoreIds(storeIds)
    : await getAllCookieStoreIds();
  const matchedCookies = [];
  for (const storeId of targetStoreIds) {
    const cookies = await chrome.cookies.getAll(storeId ? { storeId } : {}).catch(() => []);
    for (const cookie of cookies || []) {
      const domain = normalizeCookieDomain(cookie.domain);
      if (normalizedBaseDomains.some((baseDomain) => domain === baseDomain || domain.endsWith(`.${baseDomain}`))) {
        matchedCookies.push(cookie);
      }
    }
  }

  let removedCount = 0;
  const failedCookies = [];
  for (const cookie of matchedCookies) {
    const removed = await removeCookieEveryWay(cookie);
    if (removed) {
      removedCount += 1;
    } else {
      failedCookies.push(describeCookie(cookie));
    }
  }

  const remainingCookies = [];
  for (const storeId of targetStoreIds) {
    const cookies = await chrome.cookies.getAll(storeId ? { storeId } : {}).catch(() => []);
    for (const cookie of cookies || []) {
      const domain = normalizeCookieDomain(cookie.domain);
      if (normalizedBaseDomains.some((baseDomain) => domain === baseDomain || domain.endsWith(`.${baseDomain}`))) {
        remainingCookies.push(cookie);
      }
    }
  }

  logger.info("已清理指定根域 Cookie", {
    baseDomains: normalizedBaseDomains,
    storeIds: targetStoreIds,
    matchedCount: matchedCookies.length,
    removedCount,
    failedCount: failedCookies.length,
    remainingCount: remainingCookies.length,
    failedCookies: failedCookies.slice(0, 20),
    remainingCookies: remainingCookies.map(describeCookie).slice(0, 30)
  });
}

async function getAllCookieStoreIds() {
  const stores = await getAllCookieStoresSafe();
  const storeIds = normalizeCookieStoreIds(stores.map((store) => store.id));
  return storeIds.length ? storeIds : [undefined];
}

async function getCookieStoreIdForTab(tabId) {
  const numericTabId = Number(tabId);
  if (!Number.isFinite(numericTabId)) {
    return "";
  }
  const [tab, stores] = await Promise.all([
    chrome.tabs.get(numericTabId).catch(() => null),
    getAllCookieStoresSafe()
  ]);
  const matchedStore = stores.find((store) => (store.tabIds || []).includes(numericTabId));
  if (matchedStore?.id) {
    return matchedStore.id;
  }
  if (!tab?.incognito) {
    return "";
  }

  const incognitoTabIds = new Set(
    (await chrome.tabs.query({}).catch(() => []) || [])
      .filter((item) => item?.incognito)
      .map((item) => item.id)
      .filter((id) => Number.isFinite(Number(id)))
  );
  const incognitoStore = stores.find((store) => (store.tabIds || []).some((id) => incognitoTabIds.has(id)));
  if (incognitoStore?.id) {
    return incognitoStore.id;
  }

  return stores.find((store) => store.id && store.id !== "0")?.id || "";
}

function prioritizeCookieStoreIds(storeIds, preferredStoreId = "") {
  const normalizedStoreIds = normalizeCookieStoreIds(storeIds);
  const preferred = String(preferredStoreId || "").trim();
  const ordered = preferred
    ? [preferred, ...normalizedStoreIds.filter((storeId) => storeId !== preferred)]
    : normalizedStoreIds;
  return ordered.length ? [...new Set(ordered)] : [undefined];
}

function normalizeCookieStoreIds(storeIds) {
  return [...new Set((storeIds || [])
    .map((storeId) => storeId === undefined || storeId === null ? "" : String(storeId).trim())
    .filter(Boolean))];
}

async function getAllCookieStoresSafe() {
  if (!chrome.cookies?.getAllCookieStores) {
    return [];
  }
  return await chrome.cookies.getAllCookieStores().catch(() => []) || [];
}

async function removeCookieEveryWay(cookie) {
  const urls = buildCookieRemovalUrls(cookie);
  for (const url of urls) {
    const removed = await removeCookieWithDetails(cookie, url, true)
      || await removeCookieWithDetails(cookie, url, false);
    if (removed) {
      return true;
    }
  }
  return false;
}

async function removeCookieWithDetails(cookie, url, includePartitionKey) {
  const details = {
    url,
    name: cookie.name
  };
  if (cookie.storeId) {
    details.storeId = cookie.storeId;
  }
  if (includePartitionKey && cookie.partitionKey) {
    details.partitionKey = cookie.partitionKey;
  }
  return Boolean(await chrome.cookies.remove(details).catch(() => null));
}

function buildCookieRemovalUrls(cookie) {
  const domain = normalizeCookieDomain(cookie.domain);
  const path = cookie.path || "/";
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const urls = [
    buildCookieUrl(cookie),
    `https://${domain}${normalizedPath}`,
    `http://${domain}${normalizedPath}`,
    `https://${domain}/`,
    `http://${domain}/`
  ];
  return [...new Set(urls)];
}

function describeCookie(cookie) {
  return {
    name: cookie.name || "",
    domain: cookie.domain || "",
    path: cookie.path || "",
    storeId: cookie.storeId || "",
    partitioned: Boolean(cookie.partitionKey),
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly)
  };
}

function normalizeCookieDomain(value) {
  return String(value || "").trim().toLowerCase().replace(/^\.+/, "");
}

async function getXAiSsoCookie(preferredStoreId = "") {
  const cookies = [];
  const seen = new Set();
  const storeIds = prioritizeCookieStoreIds(await getAllCookieStoreIds(), preferredStoreId);
  const urls = [
    "https://accounts.x.ai/",
    "https://auth.x.ai/",
    "https://x.ai/"
  ];
  const domains = ["x.ai", ".x.ai", "accounts.x.ai", ".accounts.x.ai", "auth.x.ai", ".auth.x.ai"];

  for (const storeId of storeIds) {
    for (const url of urls) {
      const details = { url, name: "sso" };
      if (storeId) {
        details.storeId = storeId;
      }
      const cookie = await chrome.cookies.get(details).catch(() => null);
      addCookie(cookie);
    }
    for (const domain of domains) {
      const details = { domain, name: "sso" };
      if (storeId) {
        details.storeId = storeId;
      }
      const matched = await chrome.cookies.getAll(details).catch(() => []);
      for (const cookie of matched || []) {
        addCookie(cookie);
      }
    }
  }

  const selected = cookies
    .filter((cookie) => cookie?.value)
    .sort((left, right) => scoreXAiSsoCookie(right, preferredStoreId) - scoreXAiSsoCookie(left, preferredStoreId))[0] || null;
  logger.info("查询 xAI sso Cookie", {
    preferredStoreId,
    storeIds,
    matchedCount: cookies.length,
    selected: selected ? describeCookie(selected) : null
  });
  return selected;

  function addCookie(cookie) {
    if (!cookie?.value) {
      return;
    }
    const key = [
      cookie.storeId || "",
      cookie.domain || "",
      cookie.path || "",
      cookie.name || "",
      cookie.value || ""
    ].join("\n");
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    cookies.push(cookie);
  }
}

async function ensureXAiSsoCookieForAuthHosts(value, preferredStoreId = "") {
  const cookieValue = String(value || "").trim();
  if (!cookieValue) {
    return {
      injected: false,
      count: 0
    };
  }
  const storeIds = prioritizeCookieStoreIds(await getAllCookieStoreIds(), preferredStoreId).filter(Boolean);
  const targetStoreIds = storeIds.length ? storeIds.slice(0, 1) : [""];
  const results = [];
  for (const storeId of targetStoreIds) {
    for (const url of [
      "https://accounts.x.ai/",
      "https://auth.x.ai/"
    ]) {
      const details = {
        url,
        name: "sso",
        value: cookieValue,
        path: "/",
        secure: true,
        sameSite: "lax"
      };
      if (storeId) {
        details.storeId = storeId;
      }
      const result = await chrome.cookies.set(details).catch((error) => ({
        error: error?.message || String(error),
        url,
        storeId
      }));
      results.push({
        url,
        storeId,
        ok: Boolean(result && !result.error),
        error: result?.error || ""
      });
    }
  }
  return {
    injected: results.some((result) => result.ok),
    count: results.filter((result) => result.ok).length,
    preferredStoreId,
    results
  };
}

function scoreXAiSsoCookie(cookie, preferredStoreId = "") {
  const domain = String(cookie?.domain || "").toLowerCase();
  let score = 0;
  if (preferredStoreId && cookie?.storeId === preferredStoreId) {
    score += 1000;
  }
  if (domain === ".x.ai") {
    score += 30;
  }
  if (domain.includes("accounts.x.ai")) {
    score += 20;
  }
  if (domain.includes("auth.x.ai")) {
    score += 15;
  }
  if (cookie?.httpOnly) {
    score += 5;
  }
  if (cookie?.secure) {
    score += 3;
  }
  return score;
}

async function closeTabsByUrlPatterns(patterns) {
  const tabIds = new Set();
  for (const pattern of patterns) {
    const tabs = await chrome.tabs.query({ url: pattern });
    for (const tab of tabs) {
      if (tab.id) {
        tabIds.add(tab.id);
      }
    }
  }
  if (tabIds.size > 0) {
    await chrome.tabs.remove([...tabIds]).catch(() => {});
  }
}

async function closeLocalOauthCallbackTabs() {
  const tabs = await chrome.tabs.query({
    url: [
      "http://localhost/*",
      "http://127.0.0.1/*"
    ]
  });
  const tabIds = tabs
    .filter((tab) => isLocalOauthCallbackUrl(tab.url || ""))
    .map((tab) => tab.id)
    .filter(Boolean);
  if (tabIds.length > 0) {
    await chrome.tabs.remove(tabIds).catch(() => {});
    logger.info("OAuth 本地回调标签页已关闭", { count: tabIds.length });
  }
}

function isLocalOauthCallbackUrl(value) {
  try {
    const url = new URL(value);
    return ["localhost", "127.0.0.1"].includes(url.hostname)
      && url.pathname.startsWith("/auth/callback");
  } catch {
    return false;
  }
}

async function tabExists(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

function buildCookieUrl(cookie) {
  const protocol = cookie.secure ? "https:" : "http:";
  const domain = cookie.domain.replace(/^\./, "");
  return `${protocol}//${domain}${cookie.path || "/"}`;
}

function runBrowserPageAction(action, firstArg = null, secondArg = null, pageText = {}) {
  function describeElement(element) {
    return {
      tagName: element.tagName,
      text: element.textContent.trim(),
      value: element.value || "",
      id: element.id || "",
      name: element.getAttribute("name") || "",
      type: element.getAttribute("type") || "",
      placeholder: element.getAttribute("placeholder") || "",
      ariaLabel: element.getAttribute("aria-label") || "",
      testId: element.getAttribute("data-testid") || ""
    };
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden"
      && style.display !== "none"
      && element.getClientRects().length > 0;
  }

  function isEditableInput(element) {
    if (!(element instanceof HTMLInputElement)) {
      return false;
    }
    const type = (element.getAttribute("type") || "text").toLowerCase();
    const blockedTypes = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);
    return !blockedTypes.has(type)
      && !element.disabled
      && !element.readOnly
      && isVisible(element);
  }

  function findEmailInputElement() {
    const selectors = [
      "div[role='dialog'] input[id='email']",
      "div[role='dialog'] input[name='email']",
      "div[role='dialog'] input[type='email']",
      "input[id='email']",
      "input[name='email']",
      "input[type='email']",
      "input[autocomplete='email']",
      "input[inputmode='email']"
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element && isEditableInput(element)) {
        return element;
      }
    }

    return Array.from(document.querySelectorAll("input"))
      .filter(isEditableInput)
      .map((element) => ({ element, score: scoreEmailInput(element) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)[0]?.element || null;
  }

  function scoreEmailInput(element) {
    const attrs = [
      element.id,
      element.name,
      element.type,
      element.autocomplete,
      element.inputMode,
      element.placeholder,
      element.getAttribute("aria-label"),
      element.getAttribute("data-testid")
    ].filter(Boolean).join(" ").toLowerCase();
    let score = 0;
    if (attrs.includes("email")) {
      score += 10;
    }
    if (hasAnyKeyword(attrs, pageText.emailFieldHint || [])) {
      score += 10;
    }
    if (element.closest("div[role='dialog']")) {
      score += 3;
    }
    if ((element.getAttribute("type") || "").toLowerCase() === "email") {
      score += 5;
    }
    return score;
  }

  function findSignupButtonElement() {
    const direct = document.querySelector("button[data-testid='signup-button']");
    if (direct && isClickableButton(direct)) {
      return direct;
    }
    const keywords = pageText.signUp || [];
    return Array.from(document.querySelectorAll("button"))
      .find((button) => isClickableButton(button) && hasAnyKeyword(button.textContent, keywords)) || null;
  }

  function findPrimarySubmitButtonElement() {
    const selectors = [
      "div[role='dialog'] button[type='submit']",
      "button[type='submit']"
    ];
    for (const selector of selectors) {
      const button = document.querySelector(selector);
      if (button && isClickableButton(button)) {
        return button;
      }
    }
    const keywords = pageText.primarySubmit || [];
    return Array.from(document.querySelectorAll("button"))
      .find((button) => isClickableButton(button) && hasAnyKeyword(button.textContent, keywords)) || null;
  }

  function isClickableButton(element) {
    return element instanceof HTMLButtonElement
      && !element.disabled
      && element.getAttribute("aria-disabled") !== "true"
      && isVisible(element);
  }

  function hasAnyKeyword(text, keywords) {
    const normalized = String(text || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
    return keywords.some((keyword) => normalized.includes(String(keyword || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase()));
  }

  function clickElement(element) {
    element.scrollIntoView({ block: "center", inline: "center" });
    element.click();
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

  function fillTextControl(element, value) {
    element.focus();
    setNativeValue(element, "");
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    setNativeValue(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  if (action === "findEmailInput") {
    const element = findEmailInputElement();
    return element ? describeElement(element) : null;
  }

  if (action === "fillEmailInput") {
    const element = findEmailInputElement();
    if (!element) {
      return { ok: false, value: "", element: null };
    }
    fillTextControl(element, firstArg);
    return {
      ok: true,
      value: element.value || "",
      element: describeElement(element)
    };
  }

  if (action === "findSignupButton") {
    const button = findSignupButtonElement();
    return button ? describeElement(button) : null;
  }

  if (action === "clickSignupButton") {
    const button = findSignupButtonElement();
    if (!button) {
      return { ok: false, element: null };
    }
    clickElement(button);
    return { ok: true, element: describeElement(button) };
  }

  if (action === "clickPrimarySubmitButton") {
    const button = findPrimarySubmitButtonElement();
    if (!button) {
      return { ok: false, element: null };
    }
    clickElement(button);
    return { ok: true, element: describeElement(button) };
  }

  if (action === "fillSelector") {
    const element = document.querySelector(firstArg);
    if (!element) {
      return { ok: false, value: "" };
    }
    fillTextControl(element, secondArg);
    return { ok: true, value: element.value || "" };
  }

  return null;
}

function getBrowserPageTextOptions() {
  return {
    emailFieldHint: getPageTextTerms("emailFieldHint"),
    signUp: getPageTextTerms("signUp"),
    primarySubmit: getPageTextTerms("primarySubmit")
  };
}
