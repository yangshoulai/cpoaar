import { TabController } from "../core/browser.js";
import { FlowRunner, createInitialSnapshot } from "../core/flow.js";
import { STORAGE_KEYS, clearLogs, clearRegisterHistoryByAccountType, clearSnapshot, deleteRegisterHistoryRecord, loadConfig, loadLogs, loadOutlookGroups, loadRegisterHistory, loadSnapshot, saveConfig, saveOutlookGroups, saveSnapshot } from "../core/storage.js";
import { getActiveRegisterConfig, getActiveRuntimeConfig, normalizeConfig, validateConfig } from "../core/config.js";
import {
  RUN_MODES,
  getAccountTypeByMode,
  getAccountTypeLabel,
  getRunModeConfigGroups,
  getRunModeLabel,
  isOpenAiMode,
  isOpenAiRegisterMode,
  isReauthorizeMode,
  isXAiReauthorizeMode,
  normalizeRunMode
} from "../core/runModes.js";
import { createLogger } from "../core/logger.js";
import { createServices } from "../services/index.js";
import { SmsActivationStore } from "../services/smsActivationStore.js";
import { buildRegisterFlow, getManualRetryPolicy, getNodeOrder } from "../flow/registerFlowFactory.js";
import { HERO_SMS_COUNTRIES, SMS_BOWER_COUNTRIES } from "../data/smsCountries.js";
import { OPENAI_REGISTER_FLOWS, normalizeOpenAiRegisterFlow } from "../core/openAiRegisterFlows.js";

const logger = createLogger("ui");
const OPENAI_OAUTH_NODE_NAME = "select_codex_account";
const dom = {
  themeToggleButton: document.querySelector("#themeToggleButton"),
  registerModeSelect: document.querySelector("#registerModeSelect"),
  reauthorizeManualPanel: document.querySelector("#reauthorizeManualPanel"),
  reauthorizeEmailInput: document.querySelector("#reauthorizeEmailInput"),
  batchProgressPanel: document.querySelector("#batchProgressPanel"),
  batchProgressTitle: document.querySelector("#batchProgressTitle"),
  batchProgressStatus: document.querySelector("#batchProgressStatus"),
  batchProgressRound: document.querySelector("#batchProgressRound"),
  batchProgressSuccess: document.querySelector("#batchProgressSuccess"),
  batchProgressFailed: document.querySelector("#batchProgressFailed"),
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
  httpService: () => {
    const basePath = getActiveServiceConfigPath("httpService");
    return [
      section(`${getAccountTypeLabel(getCurrentAccountType())} HTTP`),
      numberField("默认超时", `${basePath}.defaultTimeout`, "秒")
    ];
  },
  emailService: () => {
    const basePath = getActiveServiceConfigPath("emailService");
    const outlookPath = `${basePath}.providers.outlook_mail`;
    const useTempEmail = () => getConfigValue(appConfig, `${outlookPath}.useTempEmail`) === true;
    return [
      section(`${getAccountTypeLabel(getCurrentAccountType())} 邮箱服务`),
      selectField("服务提供者", `${basePath}.provider`, [["outlook_mail", "OutlookMail"]]),
      textField("接口地址", `${outlookPath}.baseUrl`),
      textField("管理员密码", `${outlookPath}.adminPassword`),
      numberField("认证缓存时长", `${outlookPath}.authCacheTtlMinutes`, "分钟"),
      actionField("清除认证信息", "清除当前账号类型的 OutlookMail 登录缓存和相关 Cookie，下次操作会重新认证。", clearOutlookMailAuthentication),
      checkboxField("使用临时邮箱", `${outlookPath}.useTempEmail`),
      section("临时邮箱", useTempEmail),
      selectField("临时邮箱提供者", `${outlookPath}.tempEmail.provider`, [["cloudflare", "Cloudflare"]], "", useTempEmail),
      textField("Channel ID", `${outlookPath}.tempEmail.channelId`, "", useTempEmail),
      textField("临时邮箱域名", `${outlookPath}.tempEmail.domain`, "", useTempEmail),
      section("Outlook 邮箱池", () => !useTempEmail()),
      actionField("刷新分组", "从当前账号类型的 OutlookMail 服务获取最新分组列表。", refreshOutlookGroups, () => !useTempEmail()),
      dynamicSelectField("邮箱池分组", `${outlookPath}.outlook.poolGroupId`, getOutlookGroupOptions, "", () => !useTempEmail()),
      dynamicSelectField("已注册分组", `${outlookPath}.outlook.registeredGroupId`, getOutlookGroupOptions, "", () => !useTempEmail()),
      dynamicSelectField("已删除分组", `${outlookPath}.outlook.deletedGroupId`, getOutlookGroupOptions, "", () => !useTempEmail()),
      checkboxField("重新授权删除账号时移动邮箱", `${outlookPath}.outlook.moveEmailOnReauthorizeDelete`, () => !useTempEmail())
    ];
  },
  smsService: () => {
    const basePath = getActiveServiceConfigPath("smsService");
    const provider = () => getConfigValue(appConfig, `${basePath}.provider`);
    const isHeroSms = () => provider() === "hero_sms";
    const isSmsBower = () => provider() === "sms_bower" || provider() === "smsbower";
    return [
      section(`${getAccountTypeLabel(getCurrentAccountType())} 短信服务`),
      selectField("服务提供者", `${basePath}.provider`, [
        ["", "不启用"],
        ["hero_sms", "HeroSMS"],
        ["sms_bower", "SMSBower"],
        ["manual", "手动模式"]
      ]),
      section("HeroSMS", isHeroSms),
      textField("接口地址", `${basePath}.providers.hero_sms.baseUrl`, "", isHeroSms),
      textField("API Key", `${basePath}.providers.hero_sms.apiKey`, "", isHeroSms),
      balanceActionField("余额", "查询当前 HeroSMS 账户余额。", queryHeroSmsBalance, isHeroSms),
      countryField("目标国家", `${basePath}.providers.hero_sms.countryId`, HERO_SMS_COUNTRIES, "hero_sms", isHeroSms),
      priceField("最大价格", `${basePath}.providers.hero_sms.maxPrice`, "hero_sms", "max", "", isHeroSms),
      numberField("验证码超时", `${basePath}.providers.hero_sms.verificationCodeWaitTimeout`, "秒", isHeroSms),
      section("SMSBower", isSmsBower),
      textField("接口地址", `${basePath}.providers.sms_bower.baseUrl`, "", isSmsBower),
      textField("API Key", `${basePath}.providers.sms_bower.apiKey`, "", isSmsBower),
      countryField("目标国家", `${basePath}.providers.sms_bower.countryId`, SMS_BOWER_COUNTRIES, "sms_bower", isSmsBower),
      numberField("最低价格", `${basePath}.providers.sms_bower.minPrice`, "", isSmsBower),
      priceField("最高价格", `${basePath}.providers.sms_bower.maxPrice`, "sms_bower", "max", "", isSmsBower),
      numberField("验证码超时", `${basePath}.providers.sms_bower.verificationCodeWaitTimeout`, "秒", isSmsBower),
      numberField("激活有效期", `${basePath}.providers.sms_bower.activationValidSeconds`, "秒", isSmsBower),
      section("手动模式", () => provider() === "manual"),
      textField("手机号", `${basePath}.providers.manual.mobileNumber`, "以 + 开头；不填 + 会自动添加。", () => provider() === "manual")
    ];
  },
  accountManagementService: () => {
    const basePath = getActiveServiceConfigPath("accountManagementService");
    return [
      section(`${getAccountTypeLabel(getCurrentAccountType())} 账号服务`),
      selectField("服务提供者", `${basePath}.provider`, [["cpa", "CPA"]]),
      textField("接口地址", `${basePath}.providers.cpa.baseUrl`),
      textField("管理密钥", `${basePath}.providers.cpa.secretKey`)
    ];
  },
  register: () => {
    const basePath = getActiveRegisterConfigPath();
    return [
      section(`${getAccountTypeLabel(getCurrentAccountType())} 批量注册`),
      batchCountField("注册数量", `${basePath}.batchCount`, "失败会记录日志并继续下一轮；停止按钮会终止后续轮次。"),
      section("注册流程"),
      selectField("注册流程", `${basePath}.openAiRegisterFlow`, [
        [OPENAI_REGISTER_FLOWS.emailFirst, "先邮箱后绑定手机号"],
        [OPENAI_REGISTER_FLOWS.phoneFirst, "先手机号后邮箱绑定"]
      ], "", () => isOpenAiRegisterMode(getRegisterMode())),
      numberField("邮箱验证码超时", `${basePath}.verificationCodeWaitTimeout`, "秒"),
      numberField("手机号重试次数", `${basePath}.phoneNumberRetryAttempts`, "次", () => isOpenAiRegisterMode(getRegisterMode())),
      numberField("短信 OAuth 重试", `${basePath}.smsVerificationRetryAttempts`, "次", () => isOpenAiRegisterMode(getRegisterMode())),
      numberField("OAuth 重新认证阈值", `${basePath}.oauthReauthWaitThresholdSeconds`, "秒", () => isOpenAiRegisterMode(getRegisterMode())),
      section("手机号策略", () => isOpenAiRegisterMode(getRegisterMode())),
      checkboxField("号码复用", `${basePath}.reusePhoneNumber`, null, {
        visible: () => isOpenAiRegisterMode(getRegisterMode()),
        summary: () => formatLatestActivationSummary(latestActivationRecord)
      }),
      numberField("复用最小间隔", `${basePath}.reuseMinIntervalSeconds`, "秒", () => isOpenAiRegisterMode(getRegisterMode()))
    ];
  },
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
  chatgpt_phone_first_opened: "ChatGPT 手机注册已打开",
  email_submitted: "邮箱已提交",
  email_submitted_sms_verification_ready: "进入短信验证",
  email_submitted_create_password_ready: "需要创建密码",
  password_created: "密码已创建",
  password_created_about_you_ready: "密码已创建，进入资料页",
  password_created_phone_verification_ready: "密码已创建，进入短信验证",
  password_create_retry_startup: "手机号已存在，从头重试",
  email_verification_retry_current_node: "重新执行邮箱验证",
  email_verified: "邮箱已验证",
  email_verified_chatgpt_ready: "ChatGPT 已登录",
  codex_oauth_needs_phone: "需要手机号验证",
  codex_oauth_consent_ready: "Consent 已就绪",
  codex_oauth_add_email_ready: "需要绑定邮箱",
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
  phone_first_phone_submitted: "手机号已提交",
  sms_verification_retry_select_codex_account: "重试 OAuth",
  sms_verification_retry_startup: "从头重试",
  sms_verification_whatsapp_detected: "验证码已走 WhatsApp",
  phone_verified: "手机号已验证",
  phone_verified_about_you_ready: "手机号已验证，进入资料页",
  phone_first_email_submitted: "绑定邮箱已提交",
  codex_account_exported: "账号已导出",
  xai_email_submitted: "xAI 邮箱已提交",
  xai_email_verified: "xAI 邮箱已验证",
  xai_profile_submitted: "xAI 资料已提交",
  xai_existing_email_sign_in_ready: "邮箱已存在，进入登录",
  xai_turnstile_timeout: "xAI Turnstile 超时",
  xai_registration_completed: "xAI账号管理页面",
  xai_sign_in_completed: "xAI 登录完成",
  xai_existing_email_sign_in_failed: "邮箱已存在登录入口失败",
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
  phone_first_open_failed: "打开手机注册失败",
  email_submit_failed: "邮箱提交失败",
  email_verification_unexpected_url: "邮箱验证页面异常",
  password_create_failed: "创建密码失败",
  password_phone_account_exists: "手机号已存在",
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
  phone_first_add_email_failed: "绑定邮箱失败",
  phone_verification_unexpected_url: "手机号验证页异常",
  phone_verification_failed: "手机号验证失败",
  sms_service_not_configured: "未配置短信服务",
  sms_verification_code_timeout: "短信验证码超时",
  sms_verification_text_send_failed: "短信发送失败",
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
let flow = buildRegisterFlow(getRegisterMode(), buildFlowOptions());
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
const selectedXAiHistoryKeys = new Set();
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
let batchProgressState = null;

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
  clearBatchProgress();
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
    currentRound: 0,
    success: 0,
    failed: 0,
    stopRequested: false,
    startedAt: new Date().toISOString(),
    type: "register"
  };
  initBatchProgress({
    title: "批量注册",
    total: batchCount,
    type: "register"
  });
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
      batchRunState.currentRound = round;
      updateBatchProgressFromRunState("running");
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
      updateBatchProgressFromRunState("running");
    }
    const stopped = batchRunState.stopRequested;
    finishBatchProgress(stopped ? "stopped" : "finished");
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
    if (batchProgressState?.status === "running") {
      finishBatchProgress(batchRunState?.stopRequested ? "stopped" : "failed");
    }
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
  clearBatchProgress();
  const parsedEmails = parseReauthorizeEmailInput(dom.reauthorizeEmailInput.value);
  if (!parsedEmails.emailAddresses.length) {
    showConfigMessage("请输入有效的授权邮箱", true);
    dom.reauthorizeEmailInput.focus();
    return;
  }
  if (parsedEmails.invalidLines.length) {
    showConfigMessage(`授权邮箱格式错误：${parsedEmails.invalidLines.join("，")}`, true);
    dom.reauthorizeEmailInput.focus();
    return;
  }
  const errors = validateConfig(appConfig);
  if (errors.length) {
    showConfigMessage(errors.join("；"), true);
    return;
  }

  if (isXAiReauthorizeMode(getRegisterMode())) {
    const records = parsedEmails.emailAddresses.map(buildManualReauthorizeRecord);
    await runXAiReauthorizeBatch(records, {
      type: "xai_reauthorize_manual",
      source: "manual",
      operationName: "xAI 自定义授权",
      onSuccess: (record) => removeReauthorizeEmailFromInput(record.emailAddress)
    });
    return;
  }

  if (parsedEmails.emailAddresses.length > 1) {
    showConfigMessage("当前授权模式暂不支持多个自定义邮箱", true);
    dom.reauthorizeEmailInput.focus();
    return;
  }

  const emailAddress = parsedEmails.emailAddresses[0];
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
  clearBatchProgress();
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
  clearBatchProgress();
  const snapshot = await loadSnapshot();
  if (!snapshot?.currentNode) {
    showConfigMessage("没有可重试的当前节点", true);
    return;
  }
  if (!ensureSnapshotMatchesCurrentMode(snapshot, "重试当前节点")) {
    return;
  }
  const retryPolicy = resolveManualRetryPolicy(snapshot);
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
    startUrl,
    reason: retryPolicy.reason || ""
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
  pruneXAiHistorySelection(history);
  const accountHistoryCount = history.filter((record) => record.accountType === getCurrentAccountType()).length;
  const selectedCount = getSelectedXAiHistoryCount(history);
  const filtered = filterHistory(history);
  const totalPages = Math.max(1, Math.ceil(filtered.length / HISTORY_PAGE_SIZE));
  historyPage = Math.min(Math.max(1, historyPage), totalPages);
  const pageRecords = filtered.slice((historyPage - 1) * HISTORY_PAGE_SIZE, historyPage * HISTORY_PAGE_SIZE);
  const selectable = isXAiHistorySelectionEnabled();

  dom.dataTableWrap.innerHTML = "";
  dom.dataTableWrap.append(renderHistoryControls(filtered.length, totalPages, {
    allCount: accountHistoryCount,
    selectedCount
  }));
  if (!pageRecords.length) {
    const empty = document.createElement("div");
    empty.className = "table-empty";
    empty.textContent = accountHistoryCount ? "没有匹配的历史账号" : `暂无 ${getAccountTypeLabel(getCurrentAccountType())} 历史账号`;
    dom.dataTableWrap.append(empty);
    return;
  }
  const table = createDataTable(selectable ? [
    renderHistorySelectAllCheckbox(pageRecords),
    "邮箱",
    "注册时间",
    "操作"
  ] : [
    "邮箱",
    "注册时间",
    "操作"
  ]);
  table.classList.add("history-table");
  if (selectable) {
    table.classList.add("selectable-history-table");
  }
  for (const record of pageRecords) {
    appendDataRow(table, selectable ? [
      renderHistorySelectionCheckbox(record),
      renderCopyableText(record.emailAddress || "-", record.emailAddress || "", "邮箱"),
      formatDateTime(record.registeredAt),
      renderHistoryAction(record)
    ] : [
      renderCopyableText(record.emailAddress || "-", record.emailAddress || "", "邮箱"),
      formatDateTime(record.registeredAt),
      renderHistoryAction(record)
    ]);
  }
  dom.dataTableWrap.append(table);
}

function renderHistoryControls(totalCount, totalPages, options = {}) {
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
  const selectedCount = Number(options.selectedCount || 0);
  const clearAllButton = renderClearAllHistoryButton(options);
  const clearSelectionButton = renderClearHistorySelectionButton({ selectedCount });
  const selectionActions = clearSelectionButton ? [clearSelectionButton] : [];
  if (isXAiReauthorizeMode(getRegisterMode())) {
    const authorizeSelectedButton = renderSelectedHistoryButton({
      text: "授权选中",
      variant: "primary",
      selectedCount,
      emptyTitle: "请先勾选 xAI 历史账号",
      activeTitle: "对选中的 xAI 历史账号重新授权",
      onClick: startSelectedXAiReauthorize
    });
    wrapper.append(input, authorizeSelectedButton, ...selectionActions, clearAllButton, pager);
    return wrapper;
  }

  if (getRegisterMode() === RUN_MODES.xaiRegister) {
    const deleteSelectedButton = renderSelectedHistoryButton({
      text: "删除选中",
      variant: "danger",
      selectedCount,
      emptyTitle: "请先勾选 xAI 历史账号",
      activeTitle: "删除选中的 xAI 本地历史记录",
      onClick: deleteSelectedXAiHistoryRecords
    });
    wrapper.append(input, deleteSelectedButton, ...selectionActions, clearAllButton, pager);
    return wrapper;
  }

  wrapper.append(input, ...selectionActions, clearAllButton, pager);
  return wrapper;
}

function renderSelectedHistoryButton({
  text,
  variant,
  selectedCount,
  emptyTitle,
  activeTitle,
  onClick
}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `table-action ${variant || ""}`.trim();
  button.textContent = selectedCount ? `${text}(${selectedCount})` : text;
  button.disabled = isFlowBusy() || selectedCount <= 0;
  button.title = selectedCount ? `${activeTitle}：${selectedCount} 个` : emptyTitle;
  button.addEventListener("click", onClick);
  return button;
}

function renderClearHistorySelectionButton({ selectedCount = 0 } = {}) {
  if (!isXAiHistorySelectionEnabled() || selectedCount <= 0) {
    return null;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "table-action";
  button.textContent = "清除选择";
  button.disabled = isFlowBusy();
  button.title = isFlowBusy()
    ? "流程正在运行，暂不能清除选择"
    : `清除当前已选择的 ${selectedCount} 个 xAI 历史账号`;
  button.addEventListener("click", clearXAiHistorySelection);
  return button;
}

function clearXAiHistorySelection() {
  selectedXAiHistoryKeys.clear();
  renderHistoryTable();
}

function renderClearAllHistoryButton(options = {}) {
  const accountType = getCurrentAccountType();
  const accountTypeLabel = getAccountTypeLabel(accountType);
  const totalCount = Number(options.allCount || 0);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "table-action danger";
  button.textContent = "清除全部";
  button.disabled = isFlowBusy() || totalCount <= 0;
  button.title = totalCount
    ? `清除全部 ${totalCount} 条 ${accountTypeLabel} 本地历史记录`
    : `暂无可清除的 ${accountTypeLabel} 历史记录`;
  button.addEventListener("click", clearAllHistoryRecords);
  return button;
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

function isXAiHistorySelectionEnabled() {
  return getCurrentAccountType() === "xai";
}

function getHistoryRecordKey(record) {
  if (record?.id) {
    return `id:${record.id}`;
  }
  return [
    "legacy",
    record?.accountType || "",
    record?.flowMode || "",
    record?.emailAddress || record?.emailAccount?.emailAddress || "",
    record?.registeredAt || ""
  ].join("|");
}

function pruneXAiHistorySelection(history) {
  if (!isXAiHistorySelectionEnabled()) {
    selectedXAiHistoryKeys.clear();
    return;
  }
  const validKeys = new Set(
    history
      .filter((record) => record.accountType === getCurrentAccountType())
      .map(getHistoryRecordKey)
  );
  for (const key of [...selectedXAiHistoryKeys]) {
    if (!validKeys.has(key)) {
      selectedXAiHistoryKeys.delete(key);
    }
  }
}

function getSelectedXAiHistoryCount(history) {
  if (!isXAiHistorySelectionEnabled()) {
    return 0;
  }
  return history
    .filter((record) => record.accountType === getCurrentAccountType())
    .filter((record) => selectedXAiHistoryKeys.has(getHistoryRecordKey(record)))
    .length;
}

function renderHistorySelectAllCheckbox(records) {
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "history-select-checkbox";
  checkbox.title = "全选当前页";
  checkbox.setAttribute("aria-label", "全选当前页 xAI 历史账号");
  const selectedCount = records.filter((record) => selectedXAiHistoryKeys.has(getHistoryRecordKey(record))).length;
  checkbox.checked = records.length > 0 && selectedCount === records.length;
  checkbox.indeterminate = selectedCount > 0 && selectedCount < records.length;
  checkbox.disabled = isFlowBusy() || !records.length;
  checkbox.addEventListener("change", () => {
    for (const record of records) {
      const key = getHistoryRecordKey(record);
      if (checkbox.checked) {
        selectedXAiHistoryKeys.add(key);
      } else {
        selectedXAiHistoryKeys.delete(key);
      }
    }
    renderHistoryTable();
  });
  return checkbox;
}

function renderHistorySelectionCheckbox(record) {
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "history-select-checkbox";
  checkbox.checked = selectedXAiHistoryKeys.has(getHistoryRecordKey(record));
  checkbox.disabled = isFlowBusy();
  checkbox.title = "选择该 xAI 历史账号";
  checkbox.setAttribute("aria-label", `选择 ${record.emailAddress || "该 xAI 历史账号"}`);
  checkbox.addEventListener("change", () => {
    const key = getHistoryRecordKey(record);
    if (checkbox.checked) {
      selectedXAiHistoryKeys.add(key);
    } else {
      selectedXAiHistoryKeys.delete(key);
    }
    renderHistoryTable();
  });
  return checkbox;
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
    if (header instanceof Node) {
      th.append(header);
    } else {
      th.textContent = header;
    }
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
  if (!window.confirm(`确定删除本地历史记录？\n${record.emailAddress || ""}\n此操作不会删除邮箱或账号服务中的账号。`)) {
    return;
  }
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "删除中";
  try {
    await deleteRegisterHistoryRecord(record);
    showConfigMessage(`本地历史记录已删除：${record.emailAddress}`);
    await renderHistoryTable();
  } catch (error) {
    logger.warn("历史账号删除失败", {
      email: record.emailAddress,
      error: error.message
    });
    showConfigMessage(`本地历史记录删除失败：${error.message}`, true);
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function clearAllHistoryRecords() {
  if (isFlowBusy()) {
    showConfigMessage("流程正在运行，不能清除历史记录", true);
    return;
  }
  const accountType = getCurrentAccountType();
  const accountTypeLabel = getAccountTypeLabel(accountType);
  const history = await loadRegisterHistory();
  const count = history.filter((record) => record.accountType === accountType).length;
  if (!count) {
    showConfigMessage(`暂无 ${accountTypeLabel} 历史记录可清除`, true);
    return;
  }
  if (!window.confirm(`确定清除全部 ${count} 条 ${accountTypeLabel} 历史记录？\n此操作只清除本地历史记录，不会删除邮箱或账号服务中的账号。`)) {
    return;
  }
  await clearRegisterHistoryByAccountType(accountType);
  historyFilterValue = "";
  historyPage = 1;
  await renderHistoryTable();
  showConfigMessage(`${accountTypeLabel} 历史记录已清除：${count} 条`);
}

async function startReauthorize(record) {
  if (isFlowBusy()) {
    showConfigMessage("流程正在运行，不能启动重新授权", true);
    return;
  }
  clearBatchProgress();
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

async function getSelectedXAiHistoryRecords({ requireEmail = false } = {}) {
  const history = await loadRegisterHistory();
  pruneXAiHistorySelection(history);
  return history
    .filter((record) => record.accountType === "xai")
    .filter((record) => selectedXAiHistoryKeys.has(getHistoryRecordKey(record)))
    .filter((record) => !requireEmail || record.emailAddress || record.emailAccount?.emailAddress);
}

async function deleteSelectedXAiHistoryRecords() {
  if (isFlowBusy()) {
    showConfigMessage("流程正在运行，不能删除选中历史记录", true);
    return;
  }
  if (getRegisterMode() !== RUN_MODES.xaiRegister) {
    showConfigMessage("删除选中只支持 xAI 注册模式", true);
    return;
  }
  const records = await getSelectedXAiHistoryRecords();
  if (!records.length) {
    showConfigMessage("请先勾选要删除的 xAI 历史账号", true);
    return;
  }
  if (!window.confirm(`确定删除选中的 ${records.length} 条 xAI 本地历史记录？\n此操作不会删除邮箱或账号服务中的账号。`)) {
    return;
  }

  let success = 0;
  let failed = 0;
  for (const record of records) {
    try {
      await deleteRegisterHistoryRecord(record);
      selectedXAiHistoryKeys.delete(getHistoryRecordKey(record));
      success += 1;
    } catch (error) {
      failed += 1;
      logger.warn("选中历史记录删除失败", {
        email: record.emailAddress || record.emailAccount?.emailAddress || "",
        error: error.message
      });
    }
  }
  await renderHistoryTable();
  showConfigMessage(failed
    ? `选中历史记录删除完成：成功 ${success}，失败 ${failed}`
    : `选中历史记录已删除：${success} 条`, Boolean(failed));
}

async function startSelectedXAiReauthorize() {
  if (isFlowBusy()) {
    showConfigMessage("流程正在运行，不能启动选中授权", true);
    return;
  }
  if (!isXAiReauthorizeMode(getRegisterMode())) {
    showConfigMessage("授权选中只支持 xAI 授权模式", true);
    return;
  }
  clearBatchProgress();
  const errors = validateConfig(appConfig);
  if (errors.length) {
    showConfigMessage(errors.join("；"), true);
    return;
  }

  const records = await getSelectedXAiHistoryRecords({ requireEmail: true });
  if (!records.length) {
    showConfigMessage("请先勾选可重新授权的 xAI 历史账号", true);
    return;
  }

  await runXAiReauthorizeBatch(records, {
    type: "xai_reauthorize_selected",
    source: "selected_history",
    operationName: "xAI 选中授权",
    onSuccess: async (record) => {
      selectedXAiHistoryKeys.delete(getHistoryRecordKey(record));
      await renderHistoryTable();
    }
  });
}

async function runXAiReauthorizeBatch(records, {
  type,
  source,
  operationName,
  onSuccess = null
}) {
  await clearSnapshot();
  await clearLogs();
  dom.logList.innerHTML = "";
  renderedLogIds.clear();
  batchRunState = {
    total: records.length,
    currentRound: 0,
    success: 0,
    failed: 0,
    stopRequested: false,
    startedAt: new Date().toISOString(),
    type
  };
  initBatchProgress({
    title: operationName,
    total: records.length,
    type
  });
  updateRunButtons(lastSnapshot);
  await renderHistoryTable();
  logger.info(`${operationName}流程开始`, {
    total: records.length
  });

  try {
    for (let index = 0; index < records.length; index += 1) {
      if (batchRunState.stopRequested) {
        break;
      }
      const record = records[index];
      const round = index + 1;
      batchRunState.currentRound = round;
      updateBatchProgressFromRunState("running");
      logger.info(`${operationName}账号开始`, {
        round,
        total: records.length,
        email: record.emailAddress || record.emailAccount?.emailAddress || ""
      });

      let initialState;
      try {
        initialState = await buildReauthorizeState(record);
      } catch (error) {
        batchRunState.failed += 1;
        updateBatchProgressFromRunState("running");
        logger.warn(`${operationName}账号跳过`, {
          round,
          total: records.length,
          email: record.emailAddress || record.emailAccount?.emailAddress || "",
          error: error.message
        });
        continue;
      }

      let result;
      try {
        result = await runReauthorizeFlow(initialState, {
          email: record.emailAddress,
          emailMode: record.emailMode,
          source,
          mode: RUN_MODES.xaiReauthorize,
          preserveLogs: true
        });
      } catch (error) {
        result = {
          success: false,
          status: "exception",
          error: error.message
        };
      }
      if (result?.status === "stopped" || batchRunState.stopRequested) {
        batchRunState.stopRequested = true;
        break;
      }
      if (result?.success) {
        batchRunState.success += 1;
        if (typeof onSuccess === "function") {
          try {
            await onSuccess(record, result);
          } catch (error) {
            logger.warn(`${operationName}成功后状态回写失败`, {
              email: record.emailAddress || record.emailAccount?.emailAddress || "",
              error: error.message
            });
          }
        }
        updateBatchProgressFromRunState("running");
        logger.info(`${operationName}账号成功`, {
          round,
          total: records.length,
          email: record.emailAddress || record.emailAccount?.emailAddress || "",
          status: result.status
        });
      } else {
        batchRunState.failed += 1;
        updateBatchProgressFromRunState("running");
        logger.warn(`${operationName}账号失败，继续下一个`, {
          round,
          total: records.length,
          email: record.emailAddress || record.emailAccount?.emailAddress || "",
          status: result?.status || "",
          error: result?.error || ""
        });
      }
    }

    const stopped = batchRunState.stopRequested;
    finishBatchProgress(stopped ? "stopped" : "finished");
    logger[stopped ? "warn" : "info"](`${operationName}流程结束`, {
      total: batchRunState.total,
      success: batchRunState.success,
      failed: batchRunState.failed,
      stopped
    });
    showConfigMessage(stopped
      ? `${operationName}已停止：成功 ${batchRunState.success}，失败 ${batchRunState.failed}`
      : `${operationName}完成：成功 ${batchRunState.success}，失败 ${batchRunState.failed}`);
  } finally {
    if (batchProgressState?.status === "running") {
      finishBatchProgress(batchRunState?.stopRequested ? "stopped" : "failed");
    }
    runner = null;
    batchRunState = null;
    updateRunButtons(lastSnapshot);
    await renderHistoryTable();
  }
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
  if (!logData.preserveLogs) {
    clearBatchProgress();
  }
  if (!logData.preserveLogs) {
    await clearLogs();
    dom.logList.innerHTML = "";
    renderedLogIds.clear();
  }

  const tabs = new TabController();
  const initialSnapshot = await createInitialSnapshot(flow);
  const ctx = createRunContext(tabs, initialSnapshot, {
    ...(initialState || {}),
    preserveLogsOnStartup: Boolean(logData.preserveLogs || initialState?.preserveLogsOnStartup)
  });
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
    return await currentRunner.run();
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

function buildManualReauthorizeRecord(emailAddress) {
  const flowMode = getRegisterMode();
  return {
    accountType: getAccountTypeByMode(flowMode),
    flowMode,
    emailAddress,
    emailMode: resolveManualEmailMode() === "temp" ? "temp" : "outlook_pool",
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
  return getConfigValue(appConfig, `${getActiveServiceConfigPath("emailService")}.providers.outlook_mail.useTempEmail`) === true
    ? "temp"
    : "outlook";
}

function normalizeEmailAddress(value) {
  return String(value || "").trim().toLowerCase();
}

function parseReauthorizeEmailInput(value) {
  const rawLines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const seen = new Set();
  const emailAddresses = [];
  const invalidLines = [];
  for (const rawLine of rawLines) {
    const emailAddress = normalizeEmailAddress(rawLine);
    if (!isValidEmailAddress(emailAddress)) {
      invalidLines.push(rawLine);
      continue;
    }
    if (seen.has(emailAddress)) {
      continue;
    }
    seen.add(emailAddress);
    emailAddresses.push(emailAddress);
  }
  return {
    emailAddresses,
    invalidLines
  };
}

function removeReauthorizeEmailFromInput(emailAddress) {
  const targetEmail = normalizeEmailAddress(emailAddress);
  if (!targetEmail) {
    return;
  }
  const remainingLines = String(dom.reauthorizeEmailInput.value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => normalizeEmailAddress(line) !== targetEmail);
  dom.reauthorizeEmailInput.value = remainingLines.join("\n");
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
    ? new Date(toTime(record.lastVerificationCodeUsableAt) + Number(getConfigValue(appConfig, `${getActiveRegisterConfigPath()}.reuseMinIntervalSeconds`) || 0) * 1000)
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
  const openAiRegisterFlow = getOpenAiRegisterFlow();
  const runtimeConfig = getActiveRuntimeConfig(appConfig);
  return {
    config: runtimeConfig,
    services: createServices(runtimeConfig),
    tabs,
    state: {
      ...(state || {}),
      runMode,
      accountType,
      openAiRegisterFlow
    },
    snapshot: {
      ...snapshot,
      runMode,
      accountType,
      openAiRegisterFlow,
      status: "running",
      nodeResults: snapshot.nodeResults || {},
      nodeStarts: snapshot.nodeStarts || {}
    }
  };
}

function isFlowBusy() {
  return Boolean(batchRunState) || lastSnapshot?.status === "running";
}

function resolveManualRetryPolicy(snapshot = {}) {
  const nodeName = snapshot.currentNode || "";
  if (shouldRestartRetryFromOpenAiOAuth(snapshot)) {
    return {
      retryable: true,
      prepare: "direct",
      startNode: OPENAI_OAUTH_NODE_NAME,
      reason: "after_openai_oauth"
    };
  }
  return nodeName
    ? getManualRetryPolicy(getRegisterMode(), nodeName, buildFlowOptions())
    : { retryable: false };
}

function shouldRestartRetryFromOpenAiOAuth(snapshot = {}) {
  const currentMode = getRegisterMode();
  if (!isOpenAiMode(currentMode)) {
    return false;
  }
  const currentNode = snapshot.currentNode || "";
  if (!currentNode || currentNode === OPENAI_OAUTH_NODE_NAME) {
    return false;
  }
  const oauthResult = snapshot.nodeResults?.[OPENAI_OAUTH_NODE_NAME];
  return oauthResult?.status === "success";
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
  await resetRuntimeStateAfterModeSwitch();
  ensureActiveConfigGroup();
  renderModeSwitch();
  renderConfigTabs();
  renderConfigForm();
  await renderHistoryPanel();
  showConfigMessage(`已切换到${getRunModeLabel(normalizedMode)}模式`);
}

function rebuildFlowForMode() {
  flow = buildRegisterFlow(getRegisterMode(), buildFlowOptions());
}

async function resetRuntimeStateAfterModeSwitch() {
  runner = null;
  batchRunState = null;
  clearBatchProgress();
  await clearSnapshot();
  await clearLogs();
  dom.logList.innerHTML = "";
  renderedLogIds.clear();
  lastSnapshot = await createInitialSnapshot(flow);
  renderSnapshot(lastSnapshot);
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
  }
  if (field.path.endsWith(".openAiRegisterFlow")) {
    setConfigValue(appConfig, field.path, normalizeOpenAiRegisterFlow(getConfigValue(appConfig, field.path)));
  }
  if (field.path === "register.mode" || field.path.endsWith(".openAiRegisterFlow")) {
    rebuildFlowForMode();
    renderModeSwitch();
    ensureActiveConfigGroup();
    renderHistoryPanel();
    renderSnapshot(lastSnapshot);
  }
  if (field.path === "ui.theme") {
    applyTheme();
  }
  if (field.path.endsWith(".reuseMinIntervalSeconds")) {
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
  return `${getActiveServiceConfigPath("smsService")}.providers.${normalizeSmsProvider(provider)}`;
}

function buildConfigWithActiveSmsProvider(provider) {
  const nextConfig = JSON.parse(JSON.stringify(appConfig));
  setConfigValue(nextConfig, `${getActiveServiceConfigPath("smsService")}.provider`, normalizeSmsProvider(provider));
  return nextConfig;
}

function getFavoriteCountryIds(provider) {
  const normalizedProvider = normalizeSmsProvider(provider);
  const values = getConfigValue(appConfig, `${getActiveServiceConfigPath("smsService")}.favoriteCountries.${normalizedProvider}`);
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
    const service = createServices(buildConfigWithActiveSmsProvider("hero_sms")).smsService;
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
    const service = createServices(buildConfigWithActiveSmsProvider(normalizedProvider)).smsService;
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
    setConfigValue(appConfig, `${getSmsProviderConfigPath("hero_sms")}.maxPrice`, option.price);
  } else if (normalizedProvider === "sms_bower") {
    setConfigValue(appConfig, `${getSmsProviderConfigPath("sms_bower")}.minPrice`, option.price);
    setConfigValue(appConfig, `${getSmsProviderConfigPath("sms_bower")}.maxPrice`, option.price);
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
  setConfigValue(appConfig, `${getActiveServiceConfigPath("smsService")}.favoriteCountries.${normalizeSmsProvider(field.provider)}`, [...favorites, countryId]);
  scheduleConfigSave();
  renderConfigForm();
  showConfigMessage("常用国家已添加");
}

function removeFavoriteCountry(field, countryId) {
  const favorites = getFavoriteCountryIds(field.provider).filter((item) => item !== String(countryId));
  setConfigValue(appConfig, `${getActiveServiceConfigPath("smsService")}.favoriteCountries.${normalizeSmsProvider(field.provider)}`, favorites);
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
    rebuildFlowForMode();
    applyTheme();
    renderModeSwitch();
    renderConfigTabs();
    renderConfigForm();
    renderLogLevelControl();
    renderSnapshot(lastSnapshot);
    await renderHistoryPanel();
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

function initBatchProgress({
  title,
  total,
  type
}) {
  batchProgressState = {
    title,
    type,
    total: Number(total || 0),
    currentRound: 0,
    success: 0,
    failed: 0,
    status: "running",
    startedAt: new Date().toISOString()
  };
  renderBatchProgress();
}

function clearBatchProgress() {
  batchProgressState = null;
  renderBatchProgress();
}

function updateBatchProgressFromRunState(status = "running") {
  if (!batchRunState || !batchProgressState) {
    return;
  }
  batchProgressState = {
    ...batchProgressState,
    total: Number(batchRunState.total || batchProgressState.total || 0),
    currentRound: Number(batchRunState.currentRound || 0),
    success: Number(batchRunState.success || 0),
    failed: Number(batchRunState.failed || 0),
    status
  };
  renderBatchProgress();
}

function finishBatchProgress(status) {
  updateBatchProgressFromRunState(status);
}

function renderBatchProgress() {
  if (!dom.batchProgressPanel) {
    return;
  }
  if (!batchProgressState) {
    dom.batchProgressPanel.hidden = true;
    return;
  }
  const total = Number(batchProgressState.total || 0);
  const currentRound = Math.min(Number(batchProgressState.currentRound || 0), total || Number(batchProgressState.currentRound || 0));
  dom.batchProgressPanel.hidden = false;
  dom.batchProgressPanel.dataset.status = batchProgressState.status || "running";
  dom.batchProgressTitle.textContent = batchProgressState.title || "批量进度";
  dom.batchProgressStatus.textContent = formatBatchProgressStatus(batchProgressState.status);
  dom.batchProgressRound.textContent = total ? `${currentRound}/${total}` : "-";
  dom.batchProgressSuccess.textContent = String(Number(batchProgressState.success || 0));
  dom.batchProgressFailed.textContent = String(Number(batchProgressState.failed || 0));
}

function formatBatchProgressStatus(status) {
  switch (status) {
    case "running":
      return "运行中";
    case "stopped":
      return "已停止";
    case "finished":
      return "已完成";
    case "failed":
      return "异常";
    default:
      return "-";
  }
}

function updateRunButtons(snapshot) {
  const status = snapshot.status || "idle";
  const hasStarted = Boolean(snapshot.startedAt) || Object.keys(snapshot.nodeResults || {}).length > 0;
  const isRunning = status === "running" || Boolean(batchRunState);
  const retryPolicy = resolveManualRetryPolicy(snapshot);
  const canContinue = hasStarted && !isRunning && status !== "success" && status !== "failed";
  const canRetry = hasStarted && !isRunning && status !== "success" && retryPolicy.retryable;

  dom.startFreshButton.disabled = isRunning;
  dom.continueButton.disabled = !canContinue;
  dom.retryButton.disabled = !canRetry;
  dom.stopButton.disabled = !isRunning;
  renderBatchProgress();
  renderModeSwitch();
}

function renderNodeGraph(snapshot) {
  dom.nodeGraph.innerHTML = "";
  for (const nodeName of getNodeOrder(getRegisterMode(), buildFlowOptions())) {
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

function getOpenAiRegisterFlow() {
  return normalizeOpenAiRegisterFlow(getActiveRegisterConfig(appConfig).openAiRegisterFlow);
}

function buildFlowOptions() {
  return {
    openAiRegisterFlow: getOpenAiRegisterFlow()
  };
}

function getRegisterBatchCount() {
  return normalizeBatchCount(getActiveRegisterConfig(appConfig).batchCount);
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

function getActiveServiceConfigPath(groupName) {
  return `serviceConfigs.${getCurrentAccountType()}.${groupName}`;
}

function getActiveRegisterConfigPath() {
  return `registerConfigs.${getCurrentAccountType()}`;
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
  if (snapshotMode !== currentMode) {
    showConfigMessage(
      `${actionLabel}失败：当前快照属于${getRunModeLabel(snapshotMode)}模式，请切换回该模式后再操作`,
      true
    );
    return false;
  }
  if (isOpenAiRegisterMode(currentMode)) {
    const snapshotFlow = resolveSnapshotOpenAiRegisterFlow(snapshot);
    const currentFlow = getOpenAiRegisterFlow();
    if (snapshotFlow !== currentFlow) {
      showConfigMessage(
        `${actionLabel}失败：当前快照属于${formatOpenAiRegisterFlowLabel(snapshotFlow)}流程，请切换回该注册流程后再操作`,
        true
      );
      return false;
    }
  }
  return true;
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
    const nodeResults = snapshot.nodeResults || {};
    if (nodeResults.xai_open_signup_page || nodeResults.xai_wait_email_verification_code || nodeResults.xai_fill_profile) {
      return RUN_MODES.xaiRegister;
    }
    return RUN_MODES.xaiReauthorize;
  }
  if (["reauthorize_phone_challenge", "reauthorize_account_deleted", "reauthorize_delete_account"].includes(snapshot.currentNode)) {
    return RUN_MODES.openaiReauthorize;
  }
  return RUN_MODES.openaiRegister;
}

function resolveSnapshotOpenAiRegisterFlow(snapshot = {}) {
  const explicitFlow = snapshot.openAiRegisterFlow || snapshot.state?.openAiRegisterFlow;
  if (explicitFlow) {
    return normalizeOpenAiRegisterFlow(explicitFlow);
  }
  if ([
    "open_chatgpt_phone_first",
    "phone_first_add_phone_number",
    "phone_first_add_email"
  ].includes(snapshot.currentNode)) {
    return OPENAI_REGISTER_FLOWS.phoneFirst;
  }
  return OPENAI_REGISTER_FLOWS.emailFirst;
}

function formatOpenAiRegisterFlowLabel(value) {
  const flow = normalizeOpenAiRegisterFlow(value);
  return flow === OPENAI_REGISTER_FLOWS.phoneFirst
    ? "先手机号后邮箱绑定"
    : "先邮箱后绑定手机号";
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
    getConfigValue(appConfig, `${getActiveServiceConfigPath("emailService")}.providers.outlook_mail.outlook.poolGroupId`),
    getConfigValue(appConfig, `${getActiveServiceConfigPath("emailService")}.providers.outlook_mail.outlook.registeredGroupId`),
    getConfigValue(appConfig, `${getActiveServiceConfigPath("emailService")}.providers.outlook_mail.outlook.deletedGroupId`)
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
