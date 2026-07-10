export const RUN_MODES = Object.freeze({
  openaiRegister: "openai_register",
  openaiReauthorize: "openai_reauthorize",
  grokRegister: "grok_register"
});

export const ACCOUNT_TYPES = Object.freeze({
  openai: "openai",
  grok: "grok"
});

const LEGACY_RUN_MODE_MAP = Object.freeze({
  email_register: RUN_MODES.openaiRegister,
  reauthorize: RUN_MODES.openaiReauthorize
});

const RUN_MODE_META = Object.freeze({
  [RUN_MODES.openaiRegister]: {
    label: "OpenAI 注册",
    accountType: ACCOUNT_TYPES.openai,
    configGroups: ["accountProfile", "httpService", "emailService", "smsService", "accountManagementService", "register"]
  },
  [RUN_MODES.openaiReauthorize]: {
    label: "OpenAI 授权",
    accountType: ACCOUNT_TYPES.openai,
    configGroups: ["accountProfile", "httpService", "emailService", "accountManagementService", "reauthorize"]
  },
  [RUN_MODES.grokRegister]: {
    label: "Grok 注册",
    accountType: ACCOUNT_TYPES.grok,
    configGroups: ["accountProfile", "httpService", "emailService", "accountManagementService"]
  }
});

const ACCOUNT_TYPE_LABELS = Object.freeze({
  [ACCOUNT_TYPES.openai]: "OpenAI",
  [ACCOUNT_TYPES.grok]: "Grok"
});

export function normalizeRunMode(mode) {
  const normalized = LEGACY_RUN_MODE_MAP[mode] || mode || RUN_MODES.openaiRegister;
  return RUN_MODE_META[normalized] ? normalized : RUN_MODES.openaiRegister;
}

export function getRunModeMeta(mode) {
  return RUN_MODE_META[normalizeRunMode(mode)];
}

export function getRunModeLabel(mode) {
  return getRunModeMeta(mode).label;
}

export function getRunModeConfigGroups(mode) {
  return [...getRunModeMeta(mode).configGroups];
}

export function getAccountTypeByMode(mode) {
  return getRunModeMeta(mode).accountType;
}

export function normalizeAccountType(accountType) {
  return accountType === ACCOUNT_TYPES.grok ? ACCOUNT_TYPES.grok : ACCOUNT_TYPES.openai;
}

export function getAccountTypeLabel(accountType) {
  return ACCOUNT_TYPE_LABELS[normalizeAccountType(accountType)];
}

export function isOpenAiMode(mode) {
  return getAccountTypeByMode(mode) === ACCOUNT_TYPES.openai;
}

export function isOpenAiRegisterMode(mode) {
  return normalizeRunMode(mode) === RUN_MODES.openaiRegister;
}

export function isOpenAiReauthorizeMode(mode) {
  return normalizeRunMode(mode) === RUN_MODES.openaiReauthorize;
}

export function isGrokRegisterMode(mode) {
  return normalizeRunMode(mode) === RUN_MODES.grokRegister;
}
