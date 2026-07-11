import { TabController } from "../core/browser.js";
import { FlowRunner, createInitialSnapshot } from "../core/flow.js";
import { STORAGE_KEYS, clearLogs, clearSnapshot, loadConfig, loadLogs, loadOutlookGroups, loadRegisterHistory, loadSnapshot, saveConfig, saveOutlookGroups, saveSnapshot } from "../core/storage.js";
import { normalizeConfig, validateConfig } from "../core/config.js";
import {
  RUN_MODES,
  getAccountTypeByMode,
  getAccountTypeLabel,
  getRunModeConfigGroups,
  getRunModeLabel,
  isOpenAiRegisterMode,
  isReauthorizeMode,
  normalizeRunMode
} from "../core/runModes.js";
import { createLogger } from "../core/logger.js";
import { createServices } from "../services/index.js";
import { deleteRegisteredAccount } from "../services/accountDeletionService.js";
import { SmsActivationStore } from "../services/smsActivationStore.js";
import { buildRegisterFlow, getManualRetryPolicy, getNodeOrder } from "../flow/registerFlowFactory.js";
import { HERO_SMS_COUNTRIES, SMS_BOWER_COUNTRIES } from "../data/smsCountries.js";

const logger = createLogger("ui");
const dom = {
  themeToggleButton: document.querySelector("#themeToggleButton"),
  registerModeSelect: document.querySelector("#registerModeSelect"),
  reauthorizeManualPanel: document.querySelector("#reauthorizeManualPanel"),
  reauthorizeEmailInput: document.querySelector("#reauthorizeEmailInput"),
  startFreshButton: document.querySelector("#startFreshButton"),
  continueButton: document.querySelector("#continueButton"),
  retryButton: document.querySelector("#retryButton"),
  stopButton: document.querySelector("#stopButton"),
  dataPanel: document.querySelector("#dataPanel"),
  dataPanelTitle: document.querySelector("#dataPanelTitle"),
  refreshDataButton: document.querySelector("#refreshDataButton"),
  dataTableWrap: document.querySelector("#dataTableWrap"),
  nodeGraph: document.querySelector("#nodeGraph"),
  currentNodeText: document.querySelector("#currentNodeText"),
  attemptText: document.querySelector("#attemptText"),
  nodeStartUrl: document.querySelector("#nodeStartUrl"),
  nodeResultText: document.querySelector("#nodeResultText"),
  accountSummary: document.querySelector("#accountSummary"),
  configTabs: document.querySelector("#configTabs"),
  configForm: document.querySelector("#configForm"),
  configMessage: document.querySelector("#configMessage"),
  importButton: document.querySelector("#importButton"),
  importInput: document.querySelector("#importInput"),
  exportButton: document.querySelector("#exportButton"),
  logLevelSelect: document.querySelector("#logLevelSelect"),
  clearLogsButton: document.querySelector("#clearLogsButton"),
  logList: document.querySelector("#logList")
};

const CONFIG_GROUPS = [
  ["accountProfile", "账号"],
  ["httpService", "HTTP"],
  ["emailService", "邮箱"],
  ["smsService", "短信"],
  ["accountManagementService", "账号服务"],
  ["register", "注册器"],
  ["reauthorize", "重新授权"]
];

const CONFIG_SCHEMAS = {
  accountProfile: () => {
    const basePath = getActiveAccountProfilePath();
    return [
      section(`${getAccountTypeLabel(getCurrentAccountType())} 账号生成`),
      checkboxField("随机密码", `${basePath}.randomPassword`),
      textField("固定密码", `${basePath}.specifiedPassword`, "关闭随机密码时使用。", () => getConfigValue(appConfig, `${basePath}.randomPassword`) === false)
    ];
  },
  httpService: [
    section("HTTP"),
    numberField("默认超时", "httpService.defaultTimeout", "秒")
  ],
  emailService: [
    section("邮箱服务"),
    selectField("服务提供者", "emailService.provider", [["outlook_mail", "OutlookMail"]]),
    textField("接口地址", "emailService.providers.outlook_mail.baseUrl"),
    textField("管理员密码", "emailService.providers.outlook_mail.adminPassword"),
    numberField("认证缓存时长", "emailService.providers.outlook_mail.authCacheTtlMinutes", "分钟"),
    actionField("清除认证信息", "清除 OutlookMail 登录缓存和相关 Cookie，下次操作会重新认证。", clearOutlookMailAuthentication),
    checkboxField("使用临时邮箱", "emailService.providers.outlook_mail.useTempEmail"),
    section("临时邮箱", () => getConfigValue(appConfig, "emailService.providers.outlook_mail.useTempEmail") === true),
    selectField("临时邮箱提供者", "emailService.providers.outlook_mail.tempEmail.provider", [["cloudflare", "Cloudflare"]], "", () => getConfigValue(appConfig, "emailService.providers.outlook_mail.useTempEmail") === true),
    textField("Channel ID", "emailService.providers.outlook_mail.tempEmail.channelId", "", () => getConfigValue(appConfig, "emailService.providers.outlook_mail.useTempEmail") === true),
    textField("临时邮箱域名", "emailService.providers.outlook_mail.tempEmail.domain", "", () => getConfigValue(appConfig, "emailService.providers.outlook_mail.useTempEmail") === true),
    section("Outlook 邮箱池", () => getConfigValue(appConfig, "emailService.providers.outlook_mail.useTempEmail") !== true),
    actionField("刷新分组", "从 OutlookMail 服务获取最新分组列表。", refreshOutlookGroups, () => getConfigValue(appConfig, "emailService.providers.outlook_mail.useTempEmail") !== true),
    dynamicSelectField("邮箱池分组", "emailService.providers.outlook_mail.outlook.poolGroupId", getOutlookGroupOptions, "", () => getConfigValue(appConfig, "emailService.providers.outlook_mail.useTempEmail") !== true),
    dynamicSelectField("已注册分组", "emailService.providers.outlook_mail.outlook.registeredGroupId", getOutlookGroupOptions, "", () => getConfigValue(appConfig, "emailService.providers.outlook_mail.useTempEmail") !== true),
    dynamicSelectField("已删除分组", "emailService.providers.outlook_mail.outlook.deletedGroupId", getOutlookGroupOptions, "", () => getConfigValue(appConfig, "emailService.providers.outlook_mail.useTempEmail") !== true),
    checkboxField("重新授权删除账号时移动邮箱", "emailService.providers.outlook_mail.outlook.moveEmailOnReauthorizeDelete", () => getConfigValue(appConfig, "emailService.providers.outlook_mail.useTempEmail") !== true)
  ],
  smsService: [
    section("短信服务"),
    selectField("服务提供者", "smsService.provider", [
      ["", "不启用"],
      ["hero_sms", "HeroSMS"],
      ["sms_bower", "SMSBower"],
      ["manual", "手动模式"]
    ]),
    section("HeroSMS", () => getConfigValue(appConfig, "smsService.provider") === "hero_sms"),
    textField("接口地址", "smsService.providers.hero_sms.baseUrl", "", () => getConfigValue(appConfig, "smsService.provider") === "hero_sms"),
    textField("API Key", "smsService.providers.hero_sms.apiKey", "", () => getConfigValue(appConfig, "smsService.provider") === "hero_sms"),
    balanceActionField("余额", "查询当前 HeroSMS 账户余额。", queryHeroSmsBalance, () => getConfigValue(appConfig, "smsService.provider") === "hero_sms"),
    countryField("目标国家", "smsService.providers.hero_sms.countryId", HERO_SMS_COUNTRIES, "hero_sms", () => getConfigValue(appConfig, "smsService.provider") === "hero_sms"),
    priceField("最大价格", "smsService.providers.hero_sms.maxPrice", "hero_sms", "max", "", () => getConfigValue(appConfig, "smsService.provider") === "hero_sms"),
    numberField("验证码超时", "smsService.providers.hero_sms.verificationCodeWaitTimeout", "秒", () => getConfigValue(appConfig, "smsService.provider") === "hero_sms"),
    section("SMSBower", () => getConfigValue(appConfig, "smsService.provider") === "sms_bower" || getConfigValue(appConfig, "smsService.provider") === "smsbower"),
    textField("接口地址", "smsService.providers.sms_bower.baseUrl", "", () => getConfigValue(appConfig, "smsService.provider") === "sms_bower" || getConfigValue(appConfig, "smsService.provider") === "smsbower"),
    textField("API Key", "smsService.providers.sms_bower.apiKey", "", () => getConfigValue(appConfig, "smsService.provider") === "sms_bower" || getConfigValue(appConfig, "smsService.provider") === "smsbower"),
    countryField("目标国家", "smsService.providers.sms_bower.countryId", SMS_BOWER_COUNTRIES, "sms_bower", () => getConfigValue(appConfig, "smsService.provider") === "sms_bower" || getConfigValue(appConfig, "smsService.provider") === "smsbower"),
    numberField("最低价格", "smsService.providers.sms_bower.minPrice", "", () => getConfigValue(appConfig, "smsService.provider") === "sms_bower" || getConfigValue(appConfig, "smsService.provider") === "smsbower"),
    priceField("最高价格", "smsService.providers.sms_bower.maxPrice", "sms_bower", "max", "", () => getConfigValue(appConfig, "smsService.provider") === "sms_bower" || getConfigValue(appConfig, "smsService.provider") === "smsbower"),
    numberField("验证码超时", "smsService.providers.sms_bower.verificationCodeWaitTimeout", "秒", () => getConfigValue(appConfig, "smsService.provider") === "sms_bower" || getConfigValue(appConfig, "smsService.provider") === "smsbower"),
    numberField("激活有效期", "smsService.providers.sms_bower.activationValidSeconds", "秒", () => getConfigValue(appConfig, "smsService.provider") === "sms_bower" || getConfigValue(appConfig, "smsService.provider") === "smsbower"),
    section("手动模式", () => getConfigValue(appConfig, "smsService.provider") === "manual"),
    textField("手机号", "smsService.providers.manual.mobileNumber", "以 + 开头；不填 + 会自动添加。", () => getConfigValue(appConfig, "smsService.provider") === "manual")
  ],
  accountManagementService: [
    section("账号服务"),
    selectField("服务提供者", "accountManagementService.provider", [["cpa", "CPA"]]),
    textField("接口地址", "accountManagementService.providers.cpa.baseUrl"),
    textField("管理密钥", "accountManagementService.providers.cpa.secretKey")
  ],
  register: [
    section("批量注册"),
    batchCountField("注册数量", "register.batchCount", "失败会记录日志并继续下一轮；停止按钮会终止后续轮次。"),
    section("注册流程"),
    numberField("邮箱验证码超时", "register.verificationCodeWaitTimeout", "秒"),
    numberField("手机号重试次数", "register.phoneNumberRetryAttempts", "次", () => isOpenAiRegisterMode(getRegisterMode())),
    numberField("短信 OAuth 重试", "register.smsVerificationRetryAttempts", "次", () => isOpenAiRegisterMode(getRegisterMode())),
    numberField("OAuth 重新认证阈值", "register.oauthReauthWaitThresholdSeconds", "秒", () => isOpenAiRegisterMode(getRegisterMode())),
    section("手机号策略", () => isOpenAiRegisterMode(getRegisterMode())),
    checkboxField("号码复用", "register.reusePhoneNumber", null, {
      visible: () => isOpenAiRegisterMode(getRegisterMode()),
      summary: () => formatLatestActivationSummary(latestActivationRecord)
    }),
    numberField("复用最小间隔", "register.reuseMinIntervalSeconds", "秒", () => isOpenAiRegisterMode(getRegisterMode()))
  ],
  reauthorize: [
    section("重新授权"),
    checkboxField("账号被删时删除账号", "reauthorize.deleteAccountOnDeactivated"),
    radioField("手机号二验", "reauthorize.phoneChallengeAction", [
      ["stop", "终止流程"],
      ["delete_account", "删除账号"],
      ["manual_code", "手动填写验证码"]
    ])
  ],
};

const STATUS_LABELS = {
  idle: "待机",
  pending: "待执行",
  running: "运行中",
  waiting: "等待中",
  success: "成功",
  failed: "失败",
  stopped: "已停止",
  exception: "异常"
};

const RESULT_STATUS_LABELS = {
  startup_initialized: "初始化完成",
  chatgpt_tab_opened: "ChatGPT 已打开",
  email_submitted: "邮箱已提交",
  email_submitted_sms_verification_ready: "进入短信验证",
  email_submitted_create_password_ready: "需要创建密码",
  password_created: "密码已创建",
  password_created_about_you_ready: "密码已创建，进入资料页",
  email_verification_retry_current_node: "重新执行邮箱验证",
  email_verified: "邮箱已验证",
  email_verified_chatgpt_ready: "ChatGPT 已登录",
  codex_oauth_needs_phone: "需要手机号验证",
  codex_oauth_consent_ready: "Consent 已就绪",
  reauthorize_account_deactivated_ready: "账号已停用",
  reauthorize_account_deactivated: "账号已停用",
  reauthorize_delete_account_ready: "准备删除账号",
  reauthorize_account_deleted: "账号已删除",
  reauthorize_account_delete_failed: "账号删除失败",
  reauthorize_phone_challenge_stopped: "手机号二验已终止",
  reauthorize_phone_challenge_failed: "手机号二验失败",
  reauthorize_phone_input_missing: "缺少手机号输入框",
  reauthorize_phone_empty: "手机号为空",
  reauthorize_phone_submit_failed: "手机号提交失败",
  reauthorize_phone_code_empty: "手机号验证码为空",
  reauthorize_phone_code_input_missing: "缺少手机号验证码框",
  reauthorize_phone_code_failed: "手机号验证码失败",
  reauthorize_phone_consent_ready: "手机号二验通过",
  about_you_submitted: "资料已提交",
  about_you_retry_fill_email: "账号已存在，登录当前邮箱",
  codex_oauth_email_verification_ready: "OAuth 邮箱验证",
  phone_waited_oauth_reauth_required: "需要重新 OAuth",
  phone_submitted: "手机号已提交",
  sms_verification_retry_select_codex_account: "重试 OAuth",
  phone_verified: "手机号已验证",
  codex_account_exported: "账号已导出",
  xai_email_submitted: "xAI 邮箱已提交",
  xai_email_verified: "xAI 邮箱已验证",
  xai_profile_submitted: "xAI 资料已提交",
  xai_turnstile_timeout: "xAI Turnstile 超时",
  xai_registration_completed: "xAI 注册完成",
  xai_sign_in_completed: "xAI 登录完成",
  xai_sign_in_account_missing: "缺少 xAI 授权邮箱",
  xai_sign_in_email_input_missing: "缺少 xAI 邮箱输入框",
  xai_sign_in_next_submit_failed: "xAI 下一步失败",
  xai_sign_in_password_missing: "缺少 xAI 登录密码",
  xai_sign_in_password_input_missing: "缺少 xAI 密码输入框",
  xai_sign_in_login_submit_failed: "xAI 登录提交失败",
  xai_sign_in_turnstile_timeout: "xAI 登录 Turnstile 超时",
  xai_sign_in_failed: "xAI 登录失败",
  xai_oauth_consent_ready: "xAI OAuth Consent 已就绪",
  xai_oauth_device_continue_failed: "xAI Device 继续失败",
  xai_oauth_device_done_missing: "xAI Device 完成页缺失",
  xai_oauth_rate_limited: "xAI OAuth 限流",
  xai_oauth_rate_limited_retry: "xAI OAuth 限流重试",
  xai_oauth_state_missing: "xAI OAuth 缺少 state",
  xai_account_exported: "xAI 账号已导出",
  xai_account_export_failed: "xAI 账号导出失败",
  xai_auth_file_patch_failed: "xAI 认证文件修补失败",
  xai_device_auth_file_patched: "xAI Device 认证文件已修补",
  chatgpt_tab_open_failed: "打开失败",
  email_submit_failed: "邮箱提交失败",
  email_verification_unexpected_url: "邮箱验证页面异常",
  password_create_failed: "创建密码失败",
  email_verification_failed: "邮箱验证失败",
  email_verification_code_timeout: "邮箱验证码超时",
  account_create_failed: "账号创建失败",
  about_you_failed: "资料填写失败",
  about_you_unexpected_url: "资料页结果异常",
  codex_oauth_account_select_failed: "账号选择失败",
  codex_oauth_request_failed: "OAuth 链接获取失败",
  codex_oauth_unexpected_url: "OAuth 页面异常",
  phone_submit_failed: "手机号提交失败",
  phone_submit_error: "手机号错误",
  phone_verification_unexpected_url: "手机号验证页异常",
  phone_verification_failed: "手机号验证失败",
  sms_service_not_configured: "未配置短信服务",
  sms_verification_code_timeout: "短信验证码超时",
  sms_verification_error: "短信验证错误",
  codex_consent_submit_failed: "Consent 提交失败",
  codex_oauth_redirect_timeout: "OAuth 回调超时",
  account_export_failed: "账号导出失败"
};

const LOG_LEVEL_LABELS = {
  DEBUG: "调试",
  INFO: "信息",
  WARN: "警告",
  WARNING: "警告",
  ERROR: "错误"
};

const LOG_LEVEL_WEIGHT = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  WARNING: 30,
  ERROR: 40
};

let appConfig = normalizeConfig(await loadConfig());
let flow = buildRegisterFlow(getRegisterMode());
let activeConfigGroup = "emailService";
let runner = null;
let saveTimer = null;
let outlookGroups = await loadOutlookGroups();
let persistedSnapshot = await loadSnapshot();
if (persistedSnapshot?.status === "running") {
  persistedSnapshot = buildStoppedSnapshot(persistedSnapshot, "插件面板已重新打开，之前的运行已中断");
  await saveSnapshot(persistedSnapshot);
}
let lastSnapshot = persistedSnapshot || await createInitialSnapshot(flow);
const renderedLogIds = new Set();
const activationStore = new SmsActivationStore();
let latestActivationRecord = await activationStore.getLatestActivation();
let historyFilterValue = "";
let historyPage = 1;
const HISTORY_PAGE_SIZE = 10;
const BATCH_COUNT_PRESETS = Object.freeze([1, 5, 10, 20, 50, 100]);
const smsPriceLookupState = {};
const heroSmsBalanceState = {
  queried: false,
  loading: false,
  balance: null,
  error: ""
};
let batchRunState = null;

applyTheme();
renderAll();
bindEvents();
await renderLogs();
await renderHistoryPanel();

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "auto-register-log") {
    appendLogEntry(message.entry);
  }
  if (message.type === "auto-register-snapshot") {
    lastSnapshot = message.snapshot;
    renderSnapshot(lastSnapshot);
  }
});

window.addEventListener("auto-register-log-entry", (event) => {
  appendLogEntry(event.detail);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }
  const logsChange = changes[STORAGE_KEYS.logs];
  if (logsChange) {
    const nextLogs = logsChange.newValue || [];
    if (!nextLogs.length) {
      dom.logList.innerHTML = "";
      renderedLogIds.clear();
      return;
    }
    appendNewLogEntries(nextLogs);
  }
  if (changes[STORAGE_KEYS.registerHistory]) {
    renderHistoryTable();
  }
  if (changes[STORAGE_KEYS.outlookGroups]) {
    outlookGroups = changes[STORAGE_KEYS.outlookGroups].newValue || [];
    if (activeConfigGroup === "emailService") {
      renderConfigForm();
    }
  }
});

function bindEvents() {
  dom.registerModeSelect.addEventListener("change", () => updateRegisterMode(dom.registerModeSelect.value));
  dom.reauthorizeEmailInput.addEventListener("input", () => {
    if (isReauthorizeMode(getRegisterMode())) {
      showConfigMessage("");
    }
  });
  dom.startFreshButton.addEventListener("click", startFresh);
  dom.continueButton.addEventListener("click", continueRun);
  dom.retryButton.addEventListener("click", retryCurrentNode);
  dom.stopButton.addEventListener("click", stopRun);
  dom.refreshDataButton.addEventListener("click", renderHistoryPanel);
  dom.importButton.addEventListener("click", () => dom.importInput.click());
  dom.importInput.addEventListener("change", importConfig);
  dom.exportButton.addEventListener("click", exportConfig);
  dom.configForm.addEventListener("submit", (event) => event.preventDefault());
  dom.logLevelSelect.addEventListener("change", async () => {
    setConfigValue(appConfig, "logging.level", dom.logLevelSelect.value);
    await saveConfig(appConfig);
    await renderLogs();
    showConfigMessage("日志级别已保存");
  });
  dom.clearLogsButton.addEventListener("click", async () => {
    await clearLogs();
    dom.logList.innerHTML = "";
    renderedLogIds.clear();
  });
  dom.themeToggleButton.addEventListener("click", toggleTheme);
}

async function startFresh() {
  if (isReauthorizeMode(getRegisterMode())) {
    await startManualReauthorize();
    return;
  }
  await startRegisterFresh();
}

async function startRegisterFresh() {
  if (isFlowBusy()) {
    showConfigMessage("流程正在运行，不能重复启动", true);
    return;
  }
  const errors = validateConfig(appConfig);
  if (errors.length) {
    showConfigMessage(errors.join("；"), true);
    return;
  }
  const batchCount = getRegisterBatchCount();
  await clearSnapshot();
  await clearLogs();
  dom.logList.innerHTML = "";
  renderedLogIds.clear();
  batchRunState = {
    total: batchCount,
    success: 0,
    failed: 0,
    stopRequested: false,
    startedAt: new Date().toISOString()
  };
  logger.info("从头开始执行注册流程", {
    mode: getRegisterMode(),
    label: getRunModeLabel(getRegisterMode()),
    batchCount
  });
  try {
    for (let round = 1; round <= batchCount; round += 1) {
      if (batchRunState.stopRequested) {
        break;
      }
      await clearSnapshot();
      const result = await runRegisterBatchRound(round, batchCount);
      if (result?.status === "stopped" || batchRunState.stopRequested) {
        batchRunState.stopRequested = true;
        break;
      }
      if (result?.success) {
        batchRunState.success += 1;
      } else {
        batchRunState.failed += 1;
      }
    }
    const stopped = batchRunState.stopRequested;
    logger[stopped ? "warn" : "info"]("批量注册流程结束", {
      total: batchRunState.total,
      success: batchRunState.success,
      failed: batchRunState.failed,
      stopped
    });
    showConfigMessage(stopped
      ? `批量注册已停止：成功 ${batchRunState.success}，失败 ${batchRunState.failed}`
      : `批量注册完成：成功 ${batchRunState.success}，失败 ${batchRunState.failed}`);
  } finally {
    runner = null;
    batchRunState = null;
    updateRunButtons(lastSnapshot);
  }
}

async function runRegisterBatchRound(round, total) {
  const tabs = new TabController();
  const ctx = createRunContext(tabs, await createInitialSnapshot(flow), {
    preserveLogsOnStartup: total > 1,
    batch: {
      index: round,
      total
    }
  });
  const currentRunner = new FlowRunner(flow, ctx, renderSnapshot);
  runner = currentRunner;
  logger.info("批量注册轮次开始", {
    round,
    total,
    mode: getRegisterMode(),
    label: getRunModeLabel(getRegisterMode())
  });
  try {
    const result = await currentRunner.run();
    if (result.success) {
      logger.info("批量注册轮次成功", {
        round,
        total,
        status: result.status
      });
    } else {
      logger.warn("批量注册轮次失败，继续下一轮", {
        round,
        total,
        status: result.status,
        error: result.error || ""
      });
    }
    return result;
  } catch (error) {
    logger.warn("批量注册轮次异常，继续下一轮", {
      round,
      total,
      error: error.message
    });
    return {
      success: false,
      status: "exception",
      error: error.message
    };
  } finally {
    if (runner === currentRunner) {
      runner = null;
    }
  }
}

async function startManualReauthorize() {
  if (isFlowBusy()) {
    showConfigMessage("流程正在运行，不能启动重新授权", true);
    return;
  }
  const emailAddress = normalizeEmailAddress(dom.reauthorizeEmailInput.value);
  if (!isValidEmailAddress(emailAddress)) {
    showConfigMessage("请输入有效的授权邮箱", true);
    dom.reauthorizeEmailInput.focus();
    return;
  }
  const errors = validateConfig(appConfig);
  if (errors.length) {
    showConfigMessage(errors.join("；"), true);
    return;
  }

  let initialState;
  try {
    initialState = await buildManualReauthorizeState(emailAddress);
  } catch (error) {
    showConfigMessage(error.message, true);
    return;
  }
  await runReauthorizeFlow(initialState, {
    email: emailAddress,
    emailMode: initialState.historyRecord?.emailMode || resolveManualEmailMode(),
    source: "manual"
  });
}

async function continueRun() {
  if (isFlowBusy()) {
    showConfigMessage("流程正在运行，不能继续其它快照", true);
    return;
  }
  const snapshot = await loadSnapshot();
  if (!snapshot) {
    showConfigMessage("没有可继续的流程快照", true);
    return;
  }
  if (!ensureSnapshotMatchesCurrentMode(snapshot, "继续执行")) {
    return;
  }
  if (snapshot.status === "failed") {
    showConfigMessage("流程失败后请使用重试当前节点", true);
    return;
  }
  const tabs = new TabController();
  if (snapshot.tabId) {
    await tabs.setCurrentTab(snapshot.tabId).catch(() => {});
  }
  const ctx = createRunContext(tabs, snapshot, snapshot.state || {});
  const currentRunner = new FlowRunner(flow, ctx, renderSnapshot);
  runner = currentRunner;
  logger.info("继续执行注册流程", { currentNode: snapshot.currentNode });
  try {
    await currentRunner.run(snapshot.currentNode || flow.startNode);
  } finally {
    if (runner === currentRunner) {
      runner = null;
    }
  }
}

async function retryCurrentNode() {
  if (isFlowBusy()) {
    showConfigMessage("流程正在运行，不能重试当前节点", true);
    return;
  }
  const snapshot = await loadSnapshot();
  if (!snapshot?.currentNode) {
    showConfigMessage("没有可重试的当前节点", true);
    return;
  }
  if (!ensureSnapshotMatchesCurrentMode(snapshot, "重试当前节点")) {
    return;
  }
  const retryPolicy = getManualRetryPolicy(getRegisterMode(), snapshot.currentNode);
  if (!retryPolicy.retryable) {
    showConfigMessage(retryPolicy.message || "当前节点不支持重试", true);
    return;
  }
  const tabs = new TabController();
  let restoredTab = false;
  if (snapshot.tabId) {
    try {
      await tabs.setCurrentTab(snapshot.tabId);
      restoredTab = true;
    } catch {
      restoredTab = false;
    }
  }
  const startUrl = snapshot.nodeStarts?.[snapshot.currentNode]?.url;
  if (retryPolicy.prepare === "refresh" && restoredTab) {
    await tabs.reload().catch(() => {});
  } else if (retryPolicy.prepare === "refresh" && startUrl) {
    await tabs.navigate(startUrl);
  }

  const retryStartNode = retryPolicy.startNode || snapshot.currentNode;
  const ctx = createRunContext(tabs, snapshot, snapshot.state || {});
  const currentRunner = new FlowRunner(flow, ctx, renderSnapshot);
  runner = currentRunner;
  logger.info("手动重试当前节点", {
    node: snapshot.currentNode,
    retryStartNode,
    prepare: retryPolicy.prepare,
    startUrl
  });
  try {
    await currentRunner.run(retryStartNode);
  } finally {
    if (runner === currentRunner) {
      runner = null;
    }
  }
}

async function stopRun() {
  if (batchRunState) {
    batchRunState.stopRequested = true;
  }
  if (runner) {
    runner.stop();
  }
  const snapshot = await loadSnapshot() || lastSnapshot;
  const stoppedSnapshot = buildStoppedSnapshot(snapshot, "流程已停止");
  await saveSnapshot(stoppedSnapshot);
  lastSnapshot = stoppedSnapshot;
  renderSnapshot(stoppedSnapshot);
  logger.warn(runner ? "用户停止流程" : "用户停止流程，当前面板没有活动 runner，已修正快照状态");
}

async function renderHistoryPanel() {
  dom.dataPanelTitle.textContent = `历史记录 · ${getAccountTypeLabel(getCurrentAccountType())}`;
  await renderHistoryTable();
}

async function renderHistoryTable() {
  const history = await loadRegisterHistory();
  const accountHistoryCount = history.filter((record) => record.accountType === getCurrentAccountType()).length;
  const filtered = filterHistory(history);
  const totalPages = Math.max(1, Math.ceil(filtered.length / HISTORY_PAGE_SIZE));
  historyPage = Math.min(Math.max(1, historyPage), totalPages);
  const pageRecords = filtered.slice((historyPage - 1) * HISTORY_PAGE_SIZE, historyPage * HISTORY_PAGE_SIZE);

  dom.dataTableWrap.innerHTML = "";
  dom.dataTableWrap.append(renderHistoryControls(filtered.length, totalPages));
  if (!pageRecords.length) {
    const empty = document.createElement("div");
    empty.className = "table-empty";
    empty.textContent = accountHistoryCount ? "没有匹配的历史账号" : `暂无 ${getAccountTypeLabel(getCurrentAccountType())} 历史账号`;
    dom.dataTableWrap.append(empty);
    return;
  }
  const table = createDataTable([
    "邮箱",
    "注册时间",
    "操作"
  ]);
  table.classList.add("history-table");
  for (const record of pageRecords) {
    appendDataRow(table, [
      renderCopyableText(record.emailAddress || "-", record.emailAddress || "", "邮箱"),
      formatDateTime(record.registeredAt),
      renderHistoryAction(record)
    ]);
  }
  dom.dataTableWrap.append(table);
}

function renderHistoryControls(totalCount, totalPages) {
  const wrapper = document.createElement("div");
  wrapper.className = "data-toolbar";

  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "按邮箱过滤";
  input.value = historyFilterValue;
  input.addEventListener("input", () => {
    historyFilterValue = input.value.trim();
    historyPage = 1;
    renderHistoryTable();
  });

  const pager = document.createElement("span");
  pager.className = "pager";
  const prev = document.createElement("button");
  prev.type = "button";
  prev.textContent = "上一页";
  prev.disabled = historyPage <= 1;
  prev.addEventListener("click", () => {
    historyPage -= 1;
    renderHistoryTable();
  });
  const text = document.createElement("span");
  text.textContent = `${historyPage}/${totalPages} · ${totalCount} 条`;
  const next = document.createElement("button");
  next.type = "button";
  next.textContent = "下一页";
  next.disabled = historyPage >= totalPages;
  next.addEventListener("click", () => {
    historyPage += 1;
    renderHistoryTable();
  });
  pager.append(prev, text, next);
  wrapper.append(input, pager);
  return wrapper;
}

function filterHistory(history) {
  const accountType = getCurrentAccountType();
  const accountRecords = history.filter((record) => record.accountType === accountType);
  const keyword = historyFilterValue.toLowerCase();
  if (!keyword) {
    return accountRecords;
  }
  return accountRecords.filter((record) => String(record.emailAddress || "").toLowerCase().includes(keyword));
}

function renderHistoryAction(record) {
  const actions = document.createElement("span");
  actions.className = "table-actions";
  if (isReauthorizeMode(getRegisterMode())) {
    const reauthorizeButton = document.createElement("button");
    reauthorizeButton.type = "button";
    reauthorizeButton.className = "table-action primary";
    reauthorizeButton.textContent = "重新授权";
    reauthorizeButton.addEventListener("click", () => startReauthorize(record));
    actions.append(reauthorizeButton);
  }
  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "table-action danger";
  deleteButton.textContent = "删除";
  deleteButton.addEventListener("click", () => deleteHistoryRecord(record, deleteButton));
  actions.append(deleteButton);
  return actions;
}

function createDataTable(headers) {
  const table = document.createElement("table");
  table.className = "data-table";
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const header of headers) {
    const th = document.createElement("th");
    th.textContent = header;
    headerRow.append(th);
  }
  thead.append(headerRow);
  table.append(thead, document.createElement("tbody"));
  return table;
}

function appendDataRow(table, cells) {
  const row = document.createElement("tr");
  for (const cell of cells) {
    const td = document.createElement("td");
    if (cell instanceof Node) {
      td.append(cell);
    } else {
      td.textContent = String(cell ?? "-");
    }
    row.append(td);
  }
  table.querySelector("tbody").append(row);
}

function renderCopyableText(displayText, copyText, label) {
  const wrapper = document.createElement("span");
  wrapper.className = "copyable-cell";
  const text = document.createElement("span");
  text.className = "copyable-text";
  text.textContent = displayText || "-";
  wrapper.append(text);

  if (copyText) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy-icon-button";
    button.title = `复制${label}`;
    button.setAttribute("aria-label", `复制${label}`);
    button.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="9" y="9" width="10" height="10" rx="2"></rect>
        <path d="M5 15V7a2 2 0 0 1 2-2h8"></path>
      </svg>
    `;
    button.addEventListener("click", () => copyTableValue(copyText, label, button));
    wrapper.append(button);
  }

  return wrapper;
}

async function copyTableValue(value, label, button) {
  const originalTitle = button.title;
  button.disabled = true;
  try {
    await writeClipboardText(value);
    button.classList.add("copied");
    showConfigMessage(`${label}已复制`);
    logger.info("表格字段已复制", { label, value });
    setTimeout(() => button.classList.remove("copied"), 900);
  } catch (error) {
    showConfigMessage(`${label}复制失败：${error.message}`, true);
    logger.warn("表格字段复制失败", { label, value, error: error.message });
  } finally {
    button.disabled = false;
    button.title = originalTitle;
  }
}

async function writeClipboardText(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // 扩展面板失焦时可能被浏览器拒绝，继续使用兼容复制方案。
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.append(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("浏览器拒绝复制");
    }
  } finally {
    textarea.remove();
  }
}

async function deleteHistoryRecord(record, button) {
  if (!window.confirm(`确定删除历史账号？\n${record.emailAddress || ""}`)) {
    return;
  }
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "删除中";
  try {
    await deleteRegisteredAccount(appConfig, record, {
      reason: "历史记录手动删除"
    });
    showConfigMessage(`历史账号已删除：${record.emailAddress}`);
    await renderHistoryTable();
  } catch (error) {
    logger.warn("历史账号删除失败", {
      email: record.emailAddress,
      error: error.message
    });
    showConfigMessage(`历史账号删除失败：${error.message}`, true);
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function startReauthorize(record) {
  if (isFlowBusy()) {
    showConfigMessage("流程正在运行，不能启动重新授权", true);
    return;
  }
  const errors = validateConfig(appConfig);
  if (errors.length) {
    showConfigMessage(errors.join("；"), true);
    return;
  }

  let initialState;
  try {
    initialState = await buildReauthorizeState(record);
  } catch (error) {
    showConfigMessage(error.message, true);
    return;
  }

  await runReauthorizeFlow(initialState, {
    email: record.emailAddress,
    emailMode: record.emailMode,
    source: "history"
  });
}

async function runReauthorizeFlow(initialState, logData = {}) {
  const targetMode = normalizeRunMode(logData.mode || initialState.runMode || getRegisterMode());
  if (!isReauthorizeMode(targetMode)) {
    showConfigMessage("当前模式不是授权模式，不能启动重新授权流程", true);
    return;
  }
  setConfigValue(appConfig, "register.mode", targetMode);
  await saveConfig(appConfig);
  rebuildFlowForMode();
  await clearSnapshot();
  await clearLogs();
  dom.logList.innerHTML = "";
  renderedLogIds.clear();

  const tabs = new TabController();
  const initialSnapshot = await createInitialSnapshot(flow);
  const ctx = createRunContext(tabs, initialSnapshot, initialState);
  const currentRunner = new FlowRunner(flow, ctx, renderSnapshot);
  runner = currentRunner;
  logger.info("开始重新授权流程", {
    email: logData.email || initialState.account?.emailAddress || "",
    emailMode: logData.emailMode || initialState.emailAccount?.attributes?.mode || "",
    source: logData.source || "",
    mode: targetMode,
    label: getRunModeLabel(targetMode)
  });
  try {
    await currentRunner.run();
  } finally {
    if (runner === currentRunner) {
      runner = null;
    }
  }
}

async function buildManualReauthorizeState(emailAddress) {
  const emailAccount = await buildManualEmailAccount(emailAddress);
  const normalizedEmailAddress = emailAccount.emailAddress || emailAddress;
  const historyRecord = buildManualHistoryRecord(normalizedEmailAddress, emailAccount);
  const password = resolveReauthorizePassword(historyRecord);
  ensureXAiReauthorizePassword(password);
  return {
    runMode: getRegisterMode(),
    historyRecord,
    emailAccount,
    account: {
      emailAddress: normalizedEmailAddress,
      mobile: "",
      name: "",
      age: "",
      password,
      emailVerificationCode: "",
      smsVerificationCode: ""
    }
  };
}

async function buildReauthorizeState(record) {
  const emailAddress = record.emailAddress || record.emailAccount?.emailAddress || "";
  const emailAccount = record.emailAccount || await buildManualEmailAccount(emailAddress);
  const password = resolveReauthorizePassword(record);
  ensureXAiReauthorizePassword(password);
  return {
    runMode: getRegisterMode(),
    historyRecord: record,
    emailAccount,
    account: {
      emailAddress: emailAddress || emailAccount?.emailAddress || "",
      mobile: String(record.mobile || "").replace(/^\+/, ""),
      name: record.name || "",
      age: record.age || "",
      password,
      emailVerificationCode: "",
      smsVerificationCode: ""
    }
  };
}

async function buildManualEmailAccount(emailAddress) {
  const mode = resolveManualEmailMode();
  if (mode === "outlook") {
    try {
      const resolved = await createServices(appConfig).emailService.findOutlookAccountByEmail(emailAddress);
      if (resolved) {
        return {
          ...resolved,
          attributes: {
            ...(resolved.attributes || {}),
            manual: true
          }
        };
      }
    } catch (error) {
      logger.warn("手动授权邮箱账号详情查询失败，继续使用邮箱地址", {
        email: emailAddress,
        error: error.message
      });
    }
  }
  return {
    emailAddress,
    attributes: {
      mode,
      manual: true
    }
  };
}

function buildManualHistoryRecord(emailAddress, emailAccount) {
  const flowMode = getRegisterMode();
  return {
    accountType: getAccountTypeByMode(flowMode),
    flowMode,
    emailAddress,
    emailMode: emailAccount.attributes?.mode === "temp" ? "temp" : "outlook_pool",
    emailAccount,
    outlookAccountId: emailAccount.attributes?.accountId || "",
    outlookAccount: emailAccount.attributes?.account || null,
    mobile: "",
    name: "",
    age: "",
    birthDate: "",
    password: resolveConfiguredPasswordForCurrentAccountType()
  };
}

function resolveReauthorizePassword(record = {}) {
  return String(record.password || resolveConfiguredPasswordForCurrentAccountType() || "").trim();
}

function resolveConfiguredPasswordForCurrentAccountType() {
  return String(getConfigValue(appConfig, `${getActiveAccountProfilePath()}.specifiedPassword`) || "").trim();
}

function ensureXAiReauthorizePassword(password) {
  if (getCurrentAccountType() === "xai" && !String(password || "").trim()) {
    throw new Error("缺少 xAI 登录密码：请选择带密码的历史记录，或在 xAI 账号配置中设置固定密码");
  }
}

function resolveManualEmailMode() {
  return getConfigValue(appConfig, "emailService.providers.outlook_mail.useTempEmail") === true
    ? "temp"
    : "outlook";
}

function normalizeEmailAddress(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function formatMobile(value) {
  if (!value) {
    return "-";
  }
  const text = String(value);
  return text.startsWith("+") ? text : `+${text}`;
}

function formatProvider(provider) {
  const normalized = normalizeSmsProvider(provider);
  if (normalized === "hero_sms") {
    return "HeroSMS";
  }
  if (normalized === "sms_bower") {
    return "SMSBower";
  }
  if (normalized === "manual") {
    return "手动模式";
  }
  return provider || "-";
}

async function refreshLatestActivationSummary() {
  latestActivationRecord = await activationStore.getLatestActivation();
  for (const element of document.querySelectorAll("[data-latest-activation-summary]")) {
    element.textContent = formatLatestActivationSummary(latestActivationRecord);
  }
}

function formatLatestActivationSummary(record) {
  if (!record) {
    return "暂无缓存号码";
  }
  const reusableAt = record.lastVerificationCodeUsableAt
    ? new Date(toTime(record.lastVerificationCodeUsableAt) + Number(getConfigValue(appConfig, "register.reuseMinIntervalSeconds") || 0) * 1000)
    : null;
  const reusableText = reusableAt && !Number.isNaN(reusableAt.getTime())
    ? formatDateTime(reusableAt.toISOString())
    : "暂不可复用";
  return `${formatMobile(record.mobileNumber)} · ${formatProvider(record.provider)} · ${reusableText}`;
}

function normalizeSmsProvider(provider) {
  if (provider === "smsbower") {
    return "sms_bower";
  }
  if (provider === "manual_sms") {
    return "manual";
  }
  return provider;
}

function formatDateTime(value) {
  const time = toTime(value);
  if (!time) {
    return "-";
  }
  return new Date(time).toLocaleString("zh-CN", {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function toTime(value) {
  if (!value) {
    return 0;
  }
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function createRunContext(tabs, snapshot, state) {
  const runMode = getRegisterMode();
  const accountType = getAccountTypeByMode(runMode);
  return {
    config: appConfig,
    services: createServices(appConfig),
    tabs,
    state: {
      ...(state || {}),
      runMode,
      accountType
    },
    snapshot: {
      ...snapshot,
      runMode,
      accountType,
      status: "running",
      nodeResults: snapshot.nodeResults || {},
      nodeStarts: snapshot.nodeStarts || {}
    }
  };
}

function isFlowBusy() {
  return Boolean(batchRunState) || lastSnapshot?.status === "running";
}

function buildStoppedSnapshot(snapshot = {}, error = "流程已停止") {
  const currentNode = snapshot.currentNode || flow.startNode;
  const nodeResults = { ...(snapshot.nodeResults || {}) };
  if (currentNode) {
    nodeResults[currentNode] = {
      ...(nodeResults[currentNode] || {}),
      title: nodeResults[currentNode]?.title || getNodeTitle(currentNode),
      status: "stopped",
      resultStatus: "stopped",
      error,
      at: new Date().toISOString()
    };
  }
  return {
    ...snapshot,
    currentNode,
    status: "stopped",
    error,
    nodeResults
  };
}

function renderAll() {
  rebuildFlowForMode();
  renderModeSwitch();
  renderConfigTabs();
  renderConfigForm();
  renderLogLevelControl();
  renderSnapshot(lastSnapshot);
}

function renderModeSwitch() {
  const mode = getRegisterMode();
  const isRunning = isFlowBusy();
  const isCurrentReauthorizeMode = isReauthorizeMode(mode);
  dom.registerModeSelect.value = mode;
  dom.registerModeSelect.disabled = isRunning;
  dom.reauthorizeManualPanel.hidden = !isCurrentReauthorizeMode;
  dom.reauthorizeEmailInput.disabled = isRunning || !isCurrentReauthorizeMode;
}

async function updateRegisterMode(mode) {
  const normalizedMode = normalizeRunMode(mode);
  if (isFlowBusy()) {
    renderModeSwitch();
    showConfigMessage("流程运行中不能切换模式", true);
    return;
  }
  if (getRegisterMode() === normalizedMode) {
    renderModeSwitch();
    return;
  }
  setConfigValue(appConfig, "register.mode", normalizedMode);
  await saveConfig(appConfig);
  rebuildFlowForMode();
  ensureActiveConfigGroup();
  renderModeSwitch();
  renderConfigTabs();
  renderConfigForm();
  renderSnapshot(lastSnapshot);
  await renderHistoryPanel();
  showConfigMessage(`已切换到${getRunModeLabel(normalizedMode)}模式`);
}

function rebuildFlowForMode() {
  flow = buildRegisterFlow(getRegisterMode());
}

function renderConfigTabs() {
  dom.configTabs.innerHTML = "";
  const allowedGroups = new Set(getRunModeConfigGroups(getRegisterMode()));
  ensureActiveConfigGroup();
  for (const [key, label] of CONFIG_GROUPS) {
    if (!allowedGroups.has(key)) {
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = key === activeConfigGroup ? "config-tab active" : "config-tab";
    button.textContent = label;
    button.addEventListener("click", () => {
      activeConfigGroup = key;
      renderConfigTabs();
      renderConfigForm();
    });
    dom.configTabs.append(button);
  }
}

function renderConfigForm() {
  dom.configForm.innerHTML = "";
  ensureActiveConfigGroup();
  const rawSchema = CONFIG_SCHEMAS[activeConfigGroup] || [];
  const schema = typeof rawSchema === "function" ? rawSchema() : rawSchema;
  if (!schema.length) {
    const empty = document.createElement("p");
    empty.className = "empty-config";
    empty.textContent = "当前分组没有可配置项";
    dom.configForm.append(empty);
    return;
  }

  let currentSection = null;
  for (const item of schema) {
    if (item.visible && !item.visible()) {
      continue;
    }
    if (item.kind === "section") {
      currentSection = document.createElement("section");
      currentSection.className = "config-section";
      const title = document.createElement("div");
      title.className = "config-section-title";
      title.textContent = item.label;
      currentSection.append(title);
      dom.configForm.append(currentSection);
      continue;
    }
    if (!currentSection) {
      currentSection = document.createElement("section");
      currentSection.className = "config-section";
      dom.configForm.append(currentSection);
    }
    currentSection.append(renderConfigField(item));
  }
  if (activeConfigGroup === "register") {
    refreshLatestActivationSummary().catch((error) => {
      logger.warn("读取最近缓存手机号失败", { error: error.message });
    });
  }
}

function renderConfigField(field) {
  const row = document.createElement("div");
  row.className = "config-field";

  const label = document.createElement("span");
  label.className = "config-label";
  label.innerHTML = `<strong></strong>${field.help ? "<span></span>" : ""}`;
  label.querySelector("strong").textContent = field.label;
  if (field.help) {
    label.querySelector("span").textContent = field.help;
  }

  const control = document.createElement("span");
  control.className = "config-control";
  const input = createControl(field);
  if (input.dataset?.hasSubcontrol === "true") {
    row.classList.add("has-subcontrol");
  }
  control.append(input);
  row.append(label, control);
  return row;
}

function createControl(field) {
  if (field.type === "radio") {
    const wrapper = document.createElement("span");
    wrapper.className = "radio-group";
    const currentValue = String(getConfigValue(appConfig, field.path) ?? "");
    for (const [value, label] of field.options) {
      const optionLabel = document.createElement("label");
      optionLabel.className = "radio-option";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = field.path;
      input.value = value;
      input.checked = currentValue === value;
      input.addEventListener("change", () => {
        if (input.checked) {
          handleConfigControlChange(field, value, true);
        }
      });
      optionLabel.append(input, document.createTextNode(label));
      wrapper.append(optionLabel);
    }
    return wrapper;
  }

  if (field.type === "select" || field.type === "dynamic-select") {
    const select = document.createElement("select");
    select.dataset.path = field.path;
    const options = typeof field.options === "function" ? field.options() : field.options;
    for (const [value, label] of options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.append(option);
    }
    select.value = String(getConfigValue(appConfig, field.path) ?? "");
    select.addEventListener("change", () => handleConfigControlChange(field, select.value, true));
    return select;
  }

  if (field.type === "country") {
    return createCountryControl(field);
  }

  if (field.type === "action") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "config-action-button";
    button.textContent = field.buttonText || field.label;
    button.addEventListener("click", async () => {
      const originalText = button.textContent;
      button.disabled = true;
      button.textContent = "处理中...";
      try {
        await field.action();
      } finally {
        button.disabled = false;
        button.textContent = originalText;
      }
    });
    return button;
  }

  if (field.type === "balance-action") {
    return createBalanceActionControl(field);
  }

  if (field.type === "batch-count") {
    return createBatchCountControl(field);
  }

  if (field.type === "checkbox") {
    const wrapper = document.createElement("span");
    wrapper.className = "switch-control";
    const switchLabel = document.createElement("label");
    switchLabel.className = "switch-field";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.path = field.path;
    checkbox.checked = getConfigValue(appConfig, field.path) === true;
    const track = document.createElement("span");
    track.className = "switch-track";
    const text = document.createElement("span");
    text.textContent = checkbox.checked ? "开启" : "关闭";
    checkbox.addEventListener("change", () => {
      text.textContent = checkbox.checked ? "开启" : "关闭";
      handleConfigControlChange(field, checkbox.checked, true);
    });
    switchLabel.append(checkbox, track, text);
    wrapper.append(switchLabel);
    if (field.summary) {
      const summary = document.createElement("span");
      summary.className = "switch-summary";
      summary.dataset.latestActivationSummary = "true";
      summary.textContent = field.summary();
      wrapper.append(summary);
    }
    return wrapper;
  }

  const input = document.createElement("input");
  input.dataset.path = field.path;
  input.type = field.type === "number" ? "number" : "text";
  if (field.type === "number") {
    input.step = "any";
  }
  input.value = getConfigValue(appConfig, field.path) ?? "";
  input.addEventListener("input", () => {
    const value = field.type === "number"
      ? (input.value === "" ? 0 : Number(input.value))
      : input.value;
    handleConfigControlChange(field, value, false);
  });
  if (field.priceLookup) {
    return createPriceControl(field, input);
  }
  return input;
}

function createBatchCountControl(field) {
  const wrapper = document.createElement("span");
  wrapper.className = "batch-count-control";
  const select = document.createElement("select");
  select.className = "batch-count-select";
  const currentValue = normalizeBatchCount(getConfigValue(appConfig, field.path));
  for (const preset of BATCH_COUNT_PRESETS) {
    const option = document.createElement("option");
    option.value = String(preset);
    option.textContent = `${preset} 个`;
    select.append(option);
  }
  const customOption = document.createElement("option");
  customOption.value = "custom";
  customOption.textContent = "自定义";
  select.append(customOption);
  select.value = BATCH_COUNT_PRESETS.includes(currentValue) ? String(currentValue) : "custom";

  const input = document.createElement("input");
  input.type = "number";
  input.min = "1";
  input.step = "1";
  input.dataset.path = field.path;
  input.value = String(currentValue);

  select.addEventListener("change", () => {
    if (select.value === "custom") {
      input.focus();
      input.select();
      return;
    }
    const nextValue = normalizeBatchCount(select.value);
    input.value = String(nextValue);
    setBatchCountConfig(field.path, nextValue);
  });

  input.addEventListener("input", () => {
    if (input.value === "") {
      select.value = "custom";
      return;
    }
    const nextValue = normalizeBatchCount(input.value);
    select.value = BATCH_COUNT_PRESETS.includes(nextValue) ? String(nextValue) : "custom";
    setBatchCountConfig(field.path, nextValue);
  });

  input.addEventListener("blur", () => {
    const nextValue = normalizeBatchCount(input.value);
    input.value = String(nextValue);
    select.value = BATCH_COUNT_PRESETS.includes(nextValue) ? String(nextValue) : "custom";
    setBatchCountConfig(field.path, nextValue);
  });

  wrapper.append(select, input);
  return wrapper;
}

function createCountryControl(field) {
  const wrapper = document.createElement("span");
  wrapper.className = "country-picker";
  const row = document.createElement("span");
  row.className = "country-picker-row";
  const input = document.createElement("input");
  const listId = `country-list-${field.path.replace(/[^a-z0-9]/gi, "-")}`;
  input.setAttribute("list", listId);
  input.dataset.path = field.path;
  const currentCountryDisplay = () => formatSelectedCountryValue(field.countries, getConfigValue(appConfig, field.path));
  input.value = currentCountryDisplay();

  const datalist = document.createElement("datalist");
  datalist.id = listId;
  for (const country of field.countries) {
    const option = document.createElement("option");
    option.value = formatCountryOption(country);
    datalist.append(option);
  }

  input.addEventListener("focus", () => {
    input.value = "";
  });
  input.addEventListener("blur", () => {
    if (!input.value.trim()) {
      input.value = currentCountryDisplay();
    }
  });
  input.addEventListener("change", () => {
    const country = findCountryByInput(field.countries, input.value);
    if (!country) {
      input.value = currentCountryDisplay();
      showConfigMessage("请选择国家列表中的项目，或输入有效国家编号", true);
      return;
    }
    input.value = formatCountryOption(country);
    handleConfigControlChange(field, country.id, false);
    renderConfigForm();
    querySmsPrices(field.provider).catch((error) => {
      logger.warn("自动查询短信价格失败", {
        provider: field.provider,
        error: error.message
      });
    });
  });

  const favoriteButton = document.createElement("button");
  favoriteButton.type = "button";
  favoriteButton.className = "country-favorite-button";
  favoriteButton.title = "加入常用国家";
  favoriteButton.setAttribute("aria-label", "加入常用国家");
  favoriteButton.textContent = "+";
  const currentCountryId = String(getConfigValue(appConfig, field.path) || "");
  favoriteButton.disabled = !currentCountryId || getFavoriteCountryIds(field.provider).includes(currentCountryId);
  favoriteButton.addEventListener("click", () => addFavoriteCountry(field));

  const tags = renderFavoriteCountryTags(field);
  if (tags) {
    wrapper.dataset.hasSubcontrol = "true";
  }
  row.append(input, favoriteButton);
  wrapper.append(row, datalist);
  if (tags) {
    wrapper.append(tags);
  }
  return wrapper;
}

function createPriceControl(field, input) {
  const wrapper = document.createElement("span");
  wrapper.className = "price-control";
  const row = document.createElement("span");
  row.className = "price-control-row";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "price-query-button";
  button.textContent = "查询价格";
  button.disabled = !hasSelectedSmsCountry(field.priceLookup.provider);
  button.addEventListener("click", () => querySmsPrices(field.priceLookup.provider));
  const options = renderSmsPriceOptions(field.priceLookup.provider);
  if (options) {
    wrapper.dataset.hasSubcontrol = "true";
  }
  row.append(input, button);
  wrapper.append(row);
  if (options) {
    wrapper.append(options);
  }
  return wrapper;
}

function createBalanceActionControl(field) {
  const wrapper = document.createElement("span");
  wrapper.className = "balance-action-control";
  const value = document.createElement("span");
  value.className = "balance-action-value";
  if (heroSmsBalanceState.loading) {
    value.textContent = "查询中...";
  } else if (heroSmsBalanceState.error) {
    value.classList.add("error");
    value.textContent = heroSmsBalanceState.error;
  } else if (heroSmsBalanceState.queried) {
    value.textContent = formatPrice(heroSmsBalanceState.balance);
  } else {
    value.textContent = "未查询";
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "config-action-button";
  button.textContent = field.buttonText || "查询余额";
  button.disabled = heroSmsBalanceState.loading;
  button.addEventListener("click", async () => {
    await field.action();
  });

  wrapper.append(value, button);
  return wrapper;
}

function handleConfigControlChange(field, value, rerender) {
  setConfigValue(appConfig, field.path, coerceConfigValue(field, value));
  if (field.path === "register.mode") {
    setConfigValue(appConfig, "register.mode", normalizeRunMode(getConfigValue(appConfig, "register.mode")));
    rebuildFlowForMode();
    renderModeSwitch();
    ensureActiveConfigGroup();
    renderHistoryPanel();
    renderSnapshot(lastSnapshot);
  }
  if (field.path === "ui.theme") {
    applyTheme();
  }
  if (field.path === "register.reuseMinIntervalSeconds") {
    refreshLatestActivationSummary();
  }
  scheduleConfigSave();
  if (rerender || field.rerender) {
    renderConfigForm();
    renderConfigTabs();
  }
}

function coerceConfigValue(field, value) {
  if (field.type === "number") {
    return Number(value);
  }
  if (field.path.endsWith("GroupId") && value !== "") {
    return Number(value);
  }
  return value;
}

function getSmsProviderConfigPath(provider) {
  return `smsService.providers.${normalizeSmsProvider(provider)}`;
}

function getFavoriteCountryIds(provider) {
  const normalizedProvider = normalizeSmsProvider(provider);
  const values = getConfigValue(appConfig, `smsService.favoriteCountries.${normalizedProvider}`);
  return Array.isArray(values) ? values.map(String) : [];
}

function canQuerySmsPrices(provider) {
  const path = getSmsProviderConfigPath(provider);
  return Boolean(
    getConfigValue(appConfig, `${path}.baseUrl`)
    && getConfigValue(appConfig, `${path}.apiKey`)
    && getConfigValue(appConfig, `${path}.countryId`)
  );
}

function hasSelectedSmsCountry(provider) {
  return Boolean(getConfigValue(appConfig, `${getSmsProviderConfigPath(provider)}.countryId`));
}

async function queryHeroSmsBalance() {
  const path = getSmsProviderConfigPath("hero_sms");
  if (!getConfigValue(appConfig, `${path}.baseUrl`) || !getConfigValue(appConfig, `${path}.apiKey`)) {
    showConfigMessage("请先填写 HeroSMS 接口地址和 API Key", true);
    return;
  }
  heroSmsBalanceState.queried = true;
  heroSmsBalanceState.loading = true;
  heroSmsBalanceState.error = "";
  renderConfigForm();
  try {
    const service = createServices({
      ...appConfig,
      smsService: {
        ...appConfig.smsService,
        provider: "hero_sms"
      }
    }).smsService;
    const balance = await service.getBalance();
    heroSmsBalanceState.balance = balance;
    heroSmsBalanceState.error = "";
    showConfigMessage(`HeroSMS 账户余额：${formatPrice(balance)}`);
  } catch (error) {
    heroSmsBalanceState.error = error.message;
    showConfigMessage(`查询 HeroSMS 余额失败：${error.message}`, true);
  } finally {
    heroSmsBalanceState.loading = false;
    renderConfigForm();
  }
}

async function querySmsPrices(provider) {
  const normalizedProvider = normalizeSmsProvider(provider);
  const requestId = (smsPriceLookupState[normalizedProvider]?.requestId || 0) + 1;
  if (!canQuerySmsPrices(normalizedProvider)) {
    smsPriceLookupState[normalizedProvider] = {
      requestId,
      queried: true,
      loading: false,
      error: "请先填写接口地址、API Key 和目标国家",
      options: []
    };
    renderConfigForm();
    return;
  }

  smsPriceLookupState[normalizedProvider] = {
    requestId,
    queried: true,
    loading: true,
    error: "",
    options: []
  };
  renderConfigForm();

  try {
    const service = createServices({
      ...appConfig,
      smsService: {
        ...appConfig.smsService,
        provider: normalizedProvider
      }
    }).smsService;
    const options = await service.getPriceOptions();
    if (smsPriceLookupState[normalizedProvider]?.requestId !== requestId) {
      return;
    }
    smsPriceLookupState[normalizedProvider] = {
      requestId,
      queried: true,
      loading: false,
      error: "",
      options
    };
    showConfigMessage(options.length
      ? `已获取 ${formatSmsProviderName(normalizedProvider)} 价格：${options.length} 个`
      : `未获取到 ${formatSmsProviderName(normalizedProvider)} 可用价格`);
  } catch (error) {
    if (smsPriceLookupState[normalizedProvider]?.requestId !== requestId) {
      return;
    }
    smsPriceLookupState[normalizedProvider] = {
      requestId,
      queried: true,
      loading: false,
      error: error.message,
      options: []
    };
    showConfigMessage(`查询短信价格失败：${error.message}`, true);
  }
  renderConfigForm();
}

function renderSmsPriceOptions(provider) {
  const normalizedProvider = normalizeSmsProvider(provider);
  const state = smsPriceLookupState[normalizedProvider] || {};
  if (!state.loading && !state.error && !state.queried && (!Array.isArray(state.options) || !state.options.length)) {
    return null;
  }
  const wrapper = document.createElement("span");
  wrapper.className = "price-options";
  if (state.loading) {
    wrapper.textContent = "价格查询中...";
    return wrapper;
  }
  if (state.error) {
    wrapper.classList.add("error");
    wrapper.textContent = state.error;
    return wrapper;
  }
  if (!Array.isArray(state.options) || !state.options.length) {
    wrapper.textContent = state.queried ? "暂无价格候选" : "";
    return wrapper;
  }

  for (const option of state.options) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "price-option";
    button.textContent = formatPriceOption(option);
    button.title = `选择价格 ${formatPrice(option.price)}`;
    button.addEventListener("click", () => applySmsPriceOption(normalizedProvider, option));
    wrapper.append(button);
  }
  return wrapper;
}

function applySmsPriceOption(provider, option) {
  const normalizedProvider = normalizeSmsProvider(provider);
  if (normalizedProvider === "hero_sms") {
    setConfigValue(appConfig, "smsService.providers.hero_sms.maxPrice", option.price);
  } else if (normalizedProvider === "sms_bower") {
    setConfigValue(appConfig, "smsService.providers.sms_bower.minPrice", option.price);
    setConfigValue(appConfig, "smsService.providers.sms_bower.maxPrice", option.price);
  }
  scheduleConfigSave();
  renderConfigForm();
  showConfigMessage(`已选择短信价格：${formatPrice(option.price)}`);
}

function formatPriceOption(option) {
  const stock = option.physicalCount
    ? `${option.count || 0}/${option.physicalCount}`
    : `${option.count || 0}`;
  return `${formatPrice(option.price)} · ${stock}个`;
}

function formatPrice(value) {
  return Number(value).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function formatSmsProviderName(provider) {
  const normalized = normalizeSmsProvider(provider);
  if (normalized === "hero_sms") {
    return "HeroSMS";
  }
  if (normalized === "sms_bower") {
    return "SMSBower";
  }
  if (normalized === "manual") {
    return "手动模式";
  }
  return provider || "短信服务";
}

function addFavoriteCountry(field) {
  const countryId = String(getConfigValue(appConfig, field.path) || "");
  if (!countryId) {
    showConfigMessage("请先选择目标国家", true);
    return;
  }
  const favorites = getFavoriteCountryIds(field.provider);
  if (favorites.includes(countryId)) {
    return;
  }
  setConfigValue(appConfig, `smsService.favoriteCountries.${normalizeSmsProvider(field.provider)}`, [...favorites, countryId]);
  scheduleConfigSave();
  renderConfigForm();
  showConfigMessage("常用国家已添加");
}

function removeFavoriteCountry(field, countryId) {
  const favorites = getFavoriteCountryIds(field.provider).filter((item) => item !== String(countryId));
  setConfigValue(appConfig, `smsService.favoriteCountries.${normalizeSmsProvider(field.provider)}`, favorites);
  scheduleConfigSave();
  renderConfigForm();
  showConfigMessage("常用国家已删除");
}

function renderFavoriteCountryTags(field) {
  const favorites = getFavoriteCountryIds(field.provider);
  if (!favorites.length) {
    return null;
  }
  const wrapper = document.createElement("span");
  wrapper.className = "favorite-country-tags";
  for (const countryId of favorites) {
    const country = field.countries.find((item) => String(item.id) === String(countryId));
    if (!country) {
      continue;
    }
    wrapper.append(createFavoriteCountryTag(field, country));
  }
  if (!wrapper.childElementCount) {
    return null;
  }
  return wrapper;
}

function createFavoriteCountryTag(field, country) {
  const tag = document.createElement("button");
  tag.type = "button";
  tag.className = "favorite-country-tag";
  tag.textContent = formatCountryTag(country);
  tag.title = "点击切换国家，长按或悬停可删除";
  let longPressTimer = null;
  let longPressActivated = false;

  tag.addEventListener("click", (event) => {
    if (longPressActivated) {
      event.preventDefault();
      longPressActivated = false;
      return;
    }
    setConfigValue(appConfig, field.path, String(country.id));
    scheduleConfigSave();
    renderConfigForm();
    querySmsPrices(field.provider).catch((error) => {
      logger.warn("常用国家切换后查询短信价格失败", {
        provider: field.provider,
        error: error.message
      });
    });
  });
  tag.addEventListener("pointerdown", () => {
    clearTimeout(longPressTimer);
    longPressActivated = false;
    longPressTimer = setTimeout(() => {
      longPressActivated = true;
      tag.classList.add("show-remove");
    }, 600);
  });
  tag.addEventListener("pointerup", () => clearTimeout(longPressTimer));
  tag.addEventListener("pointercancel", () => clearTimeout(longPressTimer));
  tag.addEventListener("pointerleave", () => clearTimeout(longPressTimer));

  const remove = document.createElement("span");
  remove.className = "favorite-country-remove";
  remove.textContent = "×";
  remove.addEventListener("click", (event) => {
    event.stopPropagation();
    removeFavoriteCountry(field, country.id);
  });
  tag.append(remove);
  return tag;
}

function formatCountryTag(country) {
  const name = country.raw?.chn || country.raw?.eng || country.name || "国家";
  return `${name} ${country.id}`;
}

function scheduleConfigSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await saveConfig(appConfig);
    showConfigMessage("配置已自动保存");
  }, 180);
}

async function toggleTheme() {
  const currentTheme = getConfigValue(appConfig, "ui.theme") === "light" ? "light" : "dark";
  await updateTheme(currentTheme === "light" ? "dark" : "light");
}

async function updateTheme(theme) {
  setConfigValue(appConfig, "ui.theme", theme);
  applyTheme();
  await saveConfig(appConfig);
  if (activeConfigGroup === "ui") {
    renderConfigForm();
  }
  showConfigMessage("主题已保存");
}

function applyTheme() {
  const theme = getConfigValue(appConfig, "ui.theme") === "light" ? "light" : "dark";
  document.body.dataset.theme = theme;
  dom.themeToggleButton.classList.toggle("dark-active", theme === "dark");
  dom.themeToggleButton.title = theme === "light" ? "切换到深色" : "切换到浅色";
  dom.themeToggleButton.setAttribute("aria-label", dom.themeToggleButton.title);
  dom.themeToggleButton.innerHTML = theme === "light"
    ? `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="m4.93 4.93 1.41 1.41"></path><path d="m17.66 17.66 1.41 1.41"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="m6.34 17.66-1.41 1.41"></path><path d="m19.07 4.93-1.41 1.41"></path></svg>`
    : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5 7 7 0 1 0 20.5 14.5Z"></path></svg>`;
}

function renderLogLevelControl() {
  dom.logLevelSelect.value = getConfigValue(appConfig, "logging.level") || "INFO";
}

async function importConfig(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }
  try {
    appConfig = normalizeConfig(JSON.parse(await file.text()));
    await saveConfig(appConfig);
    applyTheme();
    renderConfigTabs();
    renderConfigForm();
    renderLogLevelControl();
    showConfigMessage("配置导入成功，已自动保存");
  } catch (error) {
    showConfigMessage(`配置导入失败: ${error.message}`, true);
  } finally {
    event.target.value = "";
  }
}

function exportConfig() {
  const blob = new Blob([JSON.stringify(appConfig, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "auto-register-config.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

function showConfigMessage(message, isError = false) {
  dom.configMessage.textContent = message;
  dom.configMessage.classList.toggle("error", isError);
}

function renderSnapshot(snapshot) {
  lastSnapshot = snapshot || {};

  const currentNode = lastSnapshot.currentNode || flow.startNode;
  dom.currentNodeText.textContent = getNodeTitle(currentNode);
  const currentStart = lastSnapshot.nodeStarts?.[currentNode] || {};
  const currentResult = lastSnapshot.nodeResults?.[currentNode] || {};
  dom.attemptText.textContent = currentResult.attempt ? `第 ${currentResult.attempt} 次` : "-";
  dom.nodeStartUrl.textContent = currentStart.url || "-";
  dom.nodeResultText.textContent = currentResult.error || translateResultStatus(currentResult.resultStatus || currentResult.status) || "-";
  dom.accountSummary.textContent = formatAccount(lastSnapshot.state?.account);
  updateRunButtons(lastSnapshot);
  renderNodeGraph(lastSnapshot);
  if (activeConfigGroup === "register") {
    refreshLatestActivationSummary().catch(() => {});
  }
}

function updateRunButtons(snapshot) {
  const status = snapshot.status || "idle";
  const hasStarted = Boolean(snapshot.startedAt) || Object.keys(snapshot.nodeResults || {}).length > 0;
  const isRunning = status === "running" || Boolean(batchRunState);
  const retryPolicy = snapshot.currentNode
    ? getManualRetryPolicy(getRegisterMode(), snapshot.currentNode)
    : { retryable: false };
  const canContinue = hasStarted && !isRunning && status !== "success" && status !== "failed";
  const canRetry = hasStarted && !isRunning && status !== "success" && retryPolicy.retryable;

  dom.startFreshButton.disabled = isRunning;
  dom.continueButton.disabled = !canContinue;
  dom.retryButton.disabled = !canRetry;
  dom.stopButton.disabled = !isRunning;
  renderModeSwitch();
}

function renderNodeGraph(snapshot) {
  dom.nodeGraph.innerHTML = "";
  for (const nodeName of getNodeOrder(getRegisterMode())) {
    const node = flow.getNode(nodeName);
    const result = snapshot.nodeResults?.[nodeName];
    let status = result?.status || "pending";
    if (snapshot.status === "running" && snapshot.currentNode === nodeName) {
      status = "running";
    }
    const item = document.createElement("div");
    item.className = `node-item ${status}`;
    item.innerHTML = `
      <span class="node-dot"></span>
      <span class="node-title"></span>
      <span class="node-status"></span>
    `;
    item.querySelector(".node-title").textContent = node.title;
    item.querySelector(".node-status").textContent = formatNodeStatusText(nodeName, result, status, snapshot);
    dom.nodeGraph.append(item);
  }
}

function formatNodeStatusText(nodeName, result, status, snapshot) {
  const statusText = translateResultStatus(result?.resultStatus) || translateStatus(status);
  const detail = getNodeDetailText(nodeName, snapshot);
  return detail ? `${statusText} · ${detail}` : statusText;
}

function getNodeDetailText(nodeName, snapshot) {
  const state = snapshot.state || {};
  const account = state.account || {};
  if (nodeName === "fill_email_and_submit") {
    return account.emailAddress || state.emailAccount?.emailAddress || "";
  }
  if (nodeName === "xai_open_signup_page") {
    return account.emailAddress || state.emailAccount?.emailAddress || "";
  }
  if (nodeName === "wait_email_verification_code") {
    return account.emailVerificationCode || state.emailVerificationCode || "";
  }
  if (nodeName === "xai_wait_email_verification_code") {
    return account.emailVerificationCode || state.emailVerificationCode || "";
  }
  if (nodeName === "add_phone_number") {
    const mobile = account.mobile || state.smsMobileNumber?.mobileNumber || "";
    return mobile ? formatMobile(mobile) : "";
  }
  if (nodeName === "wait_sms_verification_code") {
    return account.smsVerificationCode || state.smsVerificationCode || "";
  }
  return "";
}

async function renderLogs() {
  dom.logList.innerHTML = "";
  renderedLogIds.clear();
  const logs = await loadLogs();
  for (const entry of logs.slice(-250)) {
    appendLogEntry(entry);
  }
}

function appendLogEntry(entry) {
  if (!entry?.id || renderedLogIds.has(entry.id)) {
    return;
  }
  if (!shouldDisplayLog(entry)) {
    return;
  }
  renderedLogIds.add(entry.id);
  const row = document.createElement("div");
  row.className = "log-entry";
  row.innerHTML = `
    <span class="log-time"></span>
    <span class="log-level"></span>
    <span class="log-message"></span>
  `;
  row.querySelector(".log-time").textContent = new Date(entry.time).toLocaleTimeString("zh-CN", { hour12: false });
  const level = row.querySelector(".log-level");
  level.textContent = LOG_LEVEL_LABELS[entry.level] || entry.level || "";
  level.classList.add(entry.level);
  const dataText = entry.data ? ` ${JSON.stringify(entry.data)}` : "";
  row.querySelector(".log-message").textContent = `[${entry.source}] ${entry.message}${dataText}`;
  dom.logList.append(row);
  dom.logList.scrollTop = dom.logList.scrollHeight;
}

function appendNewLogEntries(logs) {
  for (const entry of logs.slice(-250)) {
    appendLogEntry(entry);
  }
}

function shouldDisplayLog(entry) {
  const currentLevel = getConfigValue(appConfig, "logging.level") || "INFO";
  const currentWeight = LOG_LEVEL_WEIGHT[currentLevel] ?? LOG_LEVEL_WEIGHT.INFO;
  const entryWeight = LOG_LEVEL_WEIGHT[entry.level] ?? LOG_LEVEL_WEIGHT.INFO;
  return entryWeight >= currentWeight;
}

function getNodeTitle(nodeName) {
  if (!nodeName) {
    return "未运行";
  }
  try {
    return flow.getNode(nodeName).title;
  } catch {
    return nodeName;
  }
}

function translateStatus(status) {
  return STATUS_LABELS[status] || RESULT_STATUS_LABELS[status] || "未知";
}

function translateResultStatus(status) {
  if (!status) {
    return "";
  }
  return RESULT_STATUS_LABELS[status] || STATUS_LABELS[status] || "未知状态";
}

function formatAccount(account) {
  if (!account) {
    return "-";
  }
  return [
    account.emailAddress,
    account.mobile ? `+${account.mobile}` : "",
    account.name,
    account.age ? `${account.age}岁` : "",
    account.birthDate?.value ? `生日:${account.birthDate.value}` : "",
    account.password ? `密码:${account.password}` : "",
    account.emailVerificationCode ? `邮箱码:${account.emailVerificationCode}` : "",
    account.smsVerificationCode ? `短信码:${account.smsVerificationCode}` : ""
  ].filter(Boolean).join(" · ");
}

function section(label, visible = null) {
  return { kind: "section", label, visible };
}

function textField(label, path, help = "", visible = null) {
  return { kind: "field", type: "text", label, path, help, visible };
}

function numberField(label, path, unit = "", visible = null) {
  return { kind: "field", type: "number", label, path, help: unit, visible };
}

function batchCountField(label, path, help = "", visible = null) {
  return { kind: "field", type: "batch-count", label, path, help, visible };
}

function balanceActionField(label, help, action, visible = null) {
  return { kind: "field", type: "balance-action", label, help, action, visible, buttonText: "查询余额" };
}

function priceField(label, path, provider, role, unit = "", visible = null) {
  return {
    kind: "field",
    type: "number",
    label,
    path,
    help: unit,
    visible,
    priceLookup: {
      provider,
      role
    }
  };
}

function checkboxField(label, path, visible = null, options = {}) {
  return { kind: "field", type: "checkbox", label, path, visible, rerender: true, ...options };
}

function radioField(label, path, options, help = "", visible = null) {
  return { kind: "field", type: "radio", label, path, options, help, visible, rerender: true };
}

function selectField(label, path, options, help = "", visible = null) {
  return { kind: "field", type: "select", label, path, options, help, visible, rerender: true };
}

function dynamicSelectField(label, path, options, help = "", visible = null) {
  return { kind: "field", type: "dynamic-select", label, path, options, help, visible, rerender: true };
}

function countryField(label, path, countries, provider, visible = null) {
  return { kind: "field", type: "country", label, path, countries, provider: normalizeSmsProvider(provider), visible };
}

function actionField(label, help, action, visible = null) {
  return { kind: "field", type: "action", label, help, action, visible, buttonText: label };
}

function getConfigValue(config, path) {
  return path.split(".").reduce((value, key) => value?.[key], config);
}

function getRegisterMode() {
  return normalizeRunMode(getConfigValue(appConfig, "register.mode"));
}

function getRegisterBatchCount() {
  return normalizeBatchCount(getConfigValue(appConfig, "register.batchCount"));
}

function normalizeBatchCount(value) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number >= 1 ? number : 1;
}

function setBatchCountConfig(path, value) {
  setConfigValue(appConfig, path, normalizeBatchCount(value));
  scheduleConfigSave();
}

function getCurrentAccountType() {
  return getAccountTypeByMode(getRegisterMode());
}

function getActiveAccountProfilePath() {
  return `accountProfiles.${getCurrentAccountType()}`;
}

function ensureActiveConfigGroup() {
  const allowedGroups = getRunModeConfigGroups(getRegisterMode());
  if (!allowedGroups.includes(activeConfigGroup)) {
    activeConfigGroup = allowedGroups[0] || "emailService";
  }
}

function ensureSnapshotMatchesCurrentMode(snapshot, actionLabel) {
  const snapshotMode = resolveSnapshotRunMode(snapshot);
  const currentMode = getRegisterMode();
  if (snapshotMode === currentMode) {
    return true;
  }
  showConfigMessage(
    `${actionLabel}失败：当前快照属于${getRunModeLabel(snapshotMode)}模式，请切换回该模式后再操作`,
    true
  );
  return false;
}

function resolveSnapshotRunMode(snapshot = {}) {
  if (snapshot.runMode || snapshot.state?.runMode) {
    return normalizeRunMode(snapshot.runMode || snapshot.state?.runMode);
  }
  if ([
    "grok_register_placeholder",
    "xai_open_signup_page",
    "xai_wait_email_verification_code",
    "xai_fill_profile",
    "xai_wait_registration_complete",
    "xai_refresh_oauth_and_login",
    "xai_submit_consent"
  ].includes(snapshot.currentNode)) {
    return RUN_MODES.xaiRegister;
  }
  if (snapshot.currentNode === "xai_sign_in") {
    return RUN_MODES.xaiReauthorize;
  }
  if (["reauthorize_phone_challenge", "reauthorize_account_deleted", "reauthorize_delete_account"].includes(snapshot.currentNode)) {
    return RUN_MODES.openaiReauthorize;
  }
  return RUN_MODES.openaiRegister;
}

function setConfigValue(config, path, value) {
  const keys = path.split(".");
  let target = config;
  for (const key of keys.slice(0, -1)) {
    if (!target[key] || typeof target[key] !== "object") {
      target[key] = {};
    }
    target = target[key];
  }
  target[keys[keys.length - 1]] = value;
}

async function refreshOutlookGroups() {
  try {
    const groups = await createServices(appConfig).emailService.listGroups();
    outlookGroups = groups
      .slice()
      .sort((left, right) => {
        const leftOrder = Number(left.sort_position ?? left.sort_order ?? 0);
        const rightOrder = Number(right.sort_position ?? right.sort_order ?? 0);
        if (leftOrder !== rightOrder) {
          return leftOrder - rightOrder;
        }
        return String(left.name || "").localeCompare(String(right.name || ""));
      });
    await saveOutlookGroups(outlookGroups);
    renderConfigForm();
    showConfigMessage(`Outlook 分组已刷新：${outlookGroups.length} 个`);
  } catch (error) {
    showConfigMessage(`刷新 Outlook 分组失败：${error.message}`, true);
  }
}

async function clearOutlookMailAuthentication() {
  try {
    await createServices(appConfig).emailService.clearAuthentication();
    showConfigMessage("OutlookMail 认证信息已清除，下次操作会重新认证");
  } catch (error) {
    showConfigMessage(`清除 OutlookMail 认证信息失败：${error.message}`, true);
  }
}

function getOutlookGroupOptions() {
  const currentIds = [
    getConfigValue(appConfig, "emailService.providers.outlook_mail.outlook.poolGroupId"),
    getConfigValue(appConfig, "emailService.providers.outlook_mail.outlook.registeredGroupId"),
    getConfigValue(appConfig, "emailService.providers.outlook_mail.outlook.deletedGroupId")
  ].filter((value) => value !== undefined && value !== null && value !== "");
  const options = outlookGroups.map((group) => [
    String(group.id),
    `${group.name || `分组 ${group.id}`}（ID ${group.id}，${group.account_count ?? 0} 个账号）`
  ]);
  const optionIds = new Set(options.map(([id]) => id));
  for (const id of currentIds) {
    const normalizedId = String(id);
    if (!optionIds.has(normalizedId)) {
      options.unshift([normalizedId, `当前配置 ID ${normalizedId}`]);
    }
  }
  if (!options.length) {
    options.push(["", "请先刷新分组"]);
  }
  return options;
}

function formatSelectedCountryValue(countries, value) {
  const country = countries.find((item) => String(item.id) === String(value));
  return country ? formatCountryOption(country) : String(value ?? "");
}

function formatCountryOption(country) {
  const chineseName = country.raw?.chn || "";
  const englishName = country.raw?.eng || country.name || "";
  const name = chineseName && englishName && chineseName !== englishName
    ? `${chineseName} / ${englishName}`
    : chineseName || englishName || country.name;
  return `${name}（ID ${country.id}）`;
}

function findCountryByInput(countries, value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return countries.find((country) => {
    const candidates = [
      country.id,
      country.name,
      country.raw?.chn,
      country.raw?.eng,
      country.raw?.rus,
      formatCountryOption(country)
    ];
    return candidates.some((candidate) => String(candidate || "").trim().toLowerCase() === normalized);
  }) || null;
}
