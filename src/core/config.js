import { ACCOUNT_TYPES, RUN_MODES, getAccountTypeByMode, isOpenAiRegisterMode, isReauthorizeMode, normalizeRunMode } from "./runModes.js";
import { OPENAI_REGISTER_FLOWS, normalizeOpenAiRegisterFlow } from "./openAiRegisterFlows.js";

const DEFAULT_ACCOUNT_PROFILE = Object.freeze({
  randomPassword: true,
  specifiedPassword: ""
});

const DEFAULT_HTTP_SERVICE = Object.freeze({
  defaultTimeout: 30,
  defaultHeaders: {}
});

const DEFAULT_ACCOUNT_MANAGEMENT_SERVICE = Object.freeze({
  provider: "cpa",
  providers: {
    cpa: {
      baseUrl: "http://localhost:8317/v0/management",
      secretKey: ""
    }
  }
});

const DEFAULT_EMAIL_SERVICE = Object.freeze({
  provider: "outlook_mail",
  providers: {
    outlook_mail: {
      baseUrl: "",
      adminPassword: "",
      authCacheTtlMinutes: 120,
      useTempEmail: false,
      tempEmail: {
        provider: "cloudflare",
        channelId: "1",
        domain: ""
      },
      outlook: {
        poolGroupId: 1,
        registeredGroupId: 2,
        deletedGroupId: 3,
        moveEmailOnReauthorizeDelete: false
      }
    }
  }
});

const DEFAULT_SMS_SERVICE = Object.freeze({
  provider: "hero_sms",
  favoriteCountries: {
    hero_sms: [],
    sms_bower: []
  },
  providers: {
    hero_sms: {
      baseUrl: "https://hero-sms.com/stubs/handler_api.php",
      apiKey: "",
      countryId: "31",
      maxPrice: 0.05,
      verificationCodeWaitTimeout: 125
    },
    sms_bower: {
      baseUrl: "https://smsbower.page/stubs/handler_api.php",
      apiKey: "",
      countryId: "31",
      minPrice: 0.045,
      maxPrice: 0.055,
      verificationCodeWaitTimeout: 60,
      activationValidSeconds: 1500
    },
    manual: {
      mobileNumber: ""
    }
  }
});

const DEFAULT_SERVICE_CONFIG = Object.freeze({
  httpService: DEFAULT_HTTP_SERVICE,
  emailService: DEFAULT_EMAIL_SERVICE,
  smsService: DEFAULT_SMS_SERVICE,
  accountManagementService: DEFAULT_ACCOUNT_MANAGEMENT_SERVICE
});

const DEFAULT_REGISTER_CONFIG = Object.freeze({
  openAiRegisterFlow: OPENAI_REGISTER_FLOWS.emailFirst,
  batchCount: 1,
  verificationCodeWaitTimeout: 60,
  phoneNumberRetryAttempts: 5,
  smsVerificationRetryAttempts: 5,
  oauthReauthWaitThresholdSeconds: 60,
  reusePhoneNumber: true,
  reuseMinIntervalSeconds: 900
});

export const DEFAULT_CONFIG = Object.freeze({
  ui: {
    theme: "dark"
  },
  accountProfiles: {
    openai: {
      ...DEFAULT_ACCOUNT_PROFILE
    },
    xai: {
      ...DEFAULT_ACCOUNT_PROFILE
    }
  },
  serviceConfigs: {
    openai: deepClone(DEFAULT_SERVICE_CONFIG),
    xai: deepClone(DEFAULT_SERVICE_CONFIG)
  },
  logging: {
    level: "INFO"
  },
  register: {
    mode: RUN_MODES.openaiRegister
  },
  registerConfigs: {
    openai: {
      ...DEFAULT_REGISTER_CONFIG
    },
    xai: {
      ...DEFAULT_REGISTER_CONFIG
    }
  },
  reauthorize: {
    deleteAccountOnDeactivated: false,
    phoneChallengeAction: "stop"
  }
});

export function normalizeConfig(config) {
  return deepMerge(DEFAULT_CONFIG, migrateConfig(config || {}));
}

export function getProviderConfig(config, groupName) {
  const group = getActiveServiceConfig(config, groupName);
  if (!group || !group.provider) {
    return {};
  }
  return group.providers?.[group.provider] || {};
}

export function getActiveServiceConfig(config, groupName) {
  const normalized = config?.serviceConfigs ? config : normalizeConfig(config || {});
  const accountType = getAccountTypeByMode(normalized.register?.mode);
  return normalized.serviceConfigs?.[accountType]?.[groupName]
    || normalized[groupName]
    || DEFAULT_CONFIG.serviceConfigs?.[accountType]?.[groupName]
    || {};
}

export function getActiveRegisterConfig(config) {
  const normalized = config?.registerConfigs ? config : normalizeConfig(config || {});
  return resolveActiveRegisterConfig(normalized);
}

export function getActiveRuntimeConfig(config) {
  const normalized = config?.serviceConfigs && config?.registerConfigs ? config : normalizeConfig(config || {});
  const accountType = getAccountTypeByMode(normalized.register?.mode);
  const activeServices = normalized.serviceConfigs?.[accountType] || {};
  const activeRegister = resolveActiveRegisterConfig(normalized);
  return {
    ...normalized,
    register: {
      ...activeRegister,
      mode: normalizeRunMode(normalized.register?.mode)
    },
    httpService: activeServices.httpService || normalized.httpService || DEFAULT_HTTP_SERVICE,
    emailService: activeServices.emailService || normalized.emailService || DEFAULT_EMAIL_SERVICE,
    smsService: activeServices.smsService || normalized.smsService || DEFAULT_SMS_SERVICE,
    accountManagementService: activeServices.accountManagementService
      || normalized.accountManagementService
      || DEFAULT_ACCOUNT_MANAGEMENT_SERVICE
  };
}

export function deepMerge(base, override) {
  if (!isPlainObject(base)) {
    return isPlainObject(override) ? { ...override } : override ?? base;
  }

  const result = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      result[key] = deepMerge(base[key], value);
      continue;
    }
    result[key] = value;
  }
  return result;
}

export function validateConfig(config) {
  const errors = [];
  const normalized = normalizeConfig(config);
  const runtimeConfig = getActiveRuntimeConfig(normalized);
  const emailConfig = runtimeConfig.emailService.providers.outlook_mail;
  const accountConfig = runtimeConfig.accountManagementService.providers.cpa;
  const runMode = normalizeRunMode(normalized.register.mode);
  const accountProfile = getAccountProfileConfig(normalized);
  const batchCount = Number(runtimeConfig.register.batchCount);

  if (accountProfile.randomPassword === false && !accountProfile.specifiedPassword) {
    errors.push("关闭随机密码时，固定密码不能为空");
  }
  if (!emailConfig.baseUrl) {
    errors.push("OutlookMail baseUrl 不能为空");
  }
  if (!emailConfig.adminPassword) {
    errors.push("OutlookMail adminPassword 不能为空");
  }
  if (!accountConfig.baseUrl) {
    errors.push("CPA baseUrl 不能为空");
  }
  if (!accountConfig.secretKey) {
    errors.push("CPA secretKey 不能为空");
  }
  if (!isReauthorizeMode(runMode) && (!Number.isInteger(batchCount) || batchCount < 1)) {
    errors.push("批量注册数量必须是大于等于 1 的整数");
  }
  if (isOpenAiRegisterMode(runMode) && runtimeConfig.smsService.provider) {
    const smsConfig = runtimeConfig.smsService.providers[runtimeConfig.smsService.provider];
    if (runtimeConfig.smsService.provider === "manual") {
      if (!normalizeMobileNumber(smsConfig?.mobileNumber)) {
        errors.push("手动短信模式手机号不能为空");
      }
    } else {
      if (!smsConfig?.baseUrl) {
        errors.push("短信服务 baseUrl 不能为空");
      }
      if (!smsConfig?.apiKey) {
        errors.push("短信服务 apiKey 不能为空");
      }
    }
  }
  return errors;
}

export function getAccountProfileConfig(config) {
  const normalized = config?.accountProfiles ? config : normalizeConfig(config || {});
  const accountType = getAccountTypeByMode(normalized.register?.mode);
  return normalized.accountProfiles?.[accountType] || normalized.accountProfiles?.[ACCOUNT_TYPES.openai] || DEFAULT_ACCOUNT_PROFILE;
}

function resolveActiveRegisterConfig(normalized) {
  const accountType = getAccountTypeByMode(normalized.register?.mode);
  return normalized.registerConfigs?.[accountType]
    || normalized.registerConfigs?.[ACCOUNT_TYPES.openai]
    || DEFAULT_CONFIG.registerConfigs?.[accountType]
    || DEFAULT_REGISTER_CONFIG;
}

function normalizeMobileNumber(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  return text.startsWith("+") ? text : `+${text}`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function migrateConfig(config) {
  const migrated = deepClone(config);
  if (migrated.accountExportService && !migrated.accountManagementService) {
    migrated.accountManagementService = migrated.accountExportService;
  }
  delete migrated.accountExportService;

  const legacyAccountService = migrated.accountService;
  if (legacyAccountService && !Object.hasOwn(legacyAccountService, "randomPassword")) {
    legacyAccountService.randomPassword = !legacyAccountService.specifiedPassword;
  }
  migrated.accountProfiles = {
    openai: {
      ...DEFAULT_ACCOUNT_PROFILE,
      ...(legacyAccountService || {}),
      ...(migrated.accountProfiles?.openai || {})
    },
    xai: {
      ...DEFAULT_ACCOUNT_PROFILE,
      ...(migrated.accountProfiles?.grok || {}),
      ...(migrated.accountProfiles?.xai || {})
    }
  };
  delete migrated.accountService;
  if (migrated.accountManagementService?.providers?.cpa) {
    delete migrated.accountManagementService.providers.cpa.grokBaseUrl;
    delete migrated.accountManagementService.providers.cpa.xaiBaseUrl;
  }
  migrated.register = migrated.register || {};
  migrated.register.mode = normalizeRunMode(migrated.register.mode);
  migrated.register.openAiRegisterFlow = normalizeOpenAiRegisterFlow(migrated.register.openAiRegisterFlow);

  const legacyActivationStore = migrated.smsService?.activationStore;
  if (legacyActivationStore) {
    migrated.register = migrated.register || {};
    if (!Object.hasOwn(migrated.register, "reusePhoneNumber")) {
      migrated.register.reusePhoneNumber = legacyActivationStore.reuseLocalActivation;
    }
    if (!Object.hasOwn(migrated.register, "reuseMinIntervalSeconds")) {
      migrated.register.reuseMinIntervalSeconds = legacyActivationStore.reuseMinIntervalSeconds;
    }
    delete migrated.smsService.activationStore;
  }
  migrated.smsService = migrated.smsService || {};
  if (migrated.smsService.provider === "smsbower") {
    migrated.smsService.provider = "sms_bower";
  }
  if (migrated.smsService.provider === "manual_sms") {
    migrated.smsService.provider = "manual";
  }
  if (migrated.smsService.providers?.manual_sms && !migrated.smsService.providers.manual) {
    migrated.smsService.providers.manual = migrated.smsService.providers.manual_sms;
  }
  if (migrated.smsService.providers?.manual?.mobileNumber) {
    migrated.smsService.providers.manual.mobileNumber = normalizeMobileNumber(migrated.smsService.providers.manual.mobileNumber);
  }
  migrated.smsService.favoriteCountries = {
    hero_sms: [],
    sms_bower: [],
    ...(migrated.smsService.favoriteCountries || {})
  };
  migrated.serviceConfigs = buildMigratedServiceConfigs(migrated);
  for (const accountType of Object.values(ACCOUNT_TYPES)) {
    normalizeServiceConfig(migrated.serviceConfigs[accountType]);
  }
  delete migrated.httpService;
  delete migrated.emailService;
  delete migrated.smsService;
  delete migrated.accountManagementService;
  if (Object.hasOwn(migrated.register || {}, "reuseLocalActivation") && !Object.hasOwn(migrated.register, "reusePhoneNumber")) {
    migrated.register.reusePhoneNumber = migrated.register.reuseLocalActivation;
  }
  if (migrated.register) {
    delete migrated.register.reuseLocalActivation;
    delete migrated.register.waitReusableActivationEnabled;
    delete migrated.register.cleanupSmsActivationHistoryEnabled;
  }
  migrated.registerConfigs = buildMigratedRegisterConfigs(migrated);
  for (const accountType of Object.values(ACCOUNT_TYPES)) {
    normalizeRegisterConfig(migrated.registerConfigs[accountType]);
  }
  migrated.register = {
    mode: normalizeRunMode(migrated.register?.mode)
  };
  return migrated;
}

function buildMigratedRegisterConfigs(migrated) {
  const existing = migrated.registerConfigs || {};
  const legacy = {
    ...(migrated.register || {})
  };
  delete legacy.mode;
  return {
    [ACCOUNT_TYPES.openai]: deepMerge(legacy, existing[ACCOUNT_TYPES.openai] || {}),
    [ACCOUNT_TYPES.xai]: deepMerge(
      legacy,
      deepMerge(existing.grok || {}, existing[ACCOUNT_TYPES.xai] || {})
    )
  };
}

function normalizeRegisterConfig(registerConfig = {}) {
  registerConfig.openAiRegisterFlow = normalizeOpenAiRegisterFlow(registerConfig.openAiRegisterFlow);
  delete registerConfig.mode;
  if (Object.hasOwn(registerConfig, "reuseLocalActivation") && !Object.hasOwn(registerConfig, "reusePhoneNumber")) {
    registerConfig.reusePhoneNumber = registerConfig.reuseLocalActivation;
  }
  delete registerConfig.reuseLocalActivation;
  delete registerConfig.waitReusableActivationEnabled;
  delete registerConfig.cleanupSmsActivationHistoryEnabled;
}

function buildMigratedServiceConfigs(migrated) {
  const existing = migrated.serviceConfigs || {};
  const legacy = {
    httpService: migrated.httpService || {},
    emailService: migrated.emailService || {},
    smsService: migrated.smsService || {},
    accountManagementService: migrated.accountManagementService || {}
  };
  return {
    [ACCOUNT_TYPES.openai]: deepMerge(legacy, existing[ACCOUNT_TYPES.openai] || {}),
    [ACCOUNT_TYPES.xai]: deepMerge(
      legacy,
      deepMerge(existing.grok || {}, existing[ACCOUNT_TYPES.xai] || {})
    )
  };
}

function normalizeServiceConfig(serviceConfig = {}) {
  if (serviceConfig.accountManagementService?.providers?.cpa) {
    delete serviceConfig.accountManagementService.providers.cpa.grokBaseUrl;
    delete serviceConfig.accountManagementService.providers.cpa.xaiBaseUrl;
  }
  normalizeSmsServiceConfig(serviceConfig.smsService || {});
}

function normalizeSmsServiceConfig(smsService = {}) {
  if (smsService.provider === "smsbower") {
    smsService.provider = "sms_bower";
  }
  if (smsService.provider === "manual_sms") {
    smsService.provider = "manual";
  }
  if (smsService.providers?.manual_sms && !smsService.providers.manual) {
    smsService.providers.manual = smsService.providers.manual_sms;
  }
  if (smsService.providers?.manual?.mobileNumber) {
    smsService.providers.manual.mobileNumber = normalizeMobileNumber(smsService.providers.manual.mobileNumber);
  }
  smsService.favoriteCountries = {
    hero_sms: [],
    sms_bower: [],
    ...(smsService.favoriteCountries || {})
  };
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}
