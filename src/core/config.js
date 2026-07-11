import { ACCOUNT_TYPES, RUN_MODES, getAccountTypeByMode, isOpenAiRegisterMode, isReauthorizeMode, normalizeRunMode } from "./runModes.js";

const DEFAULT_ACCOUNT_PROFILE = Object.freeze({
  randomPassword: true,
  specifiedPassword: ""
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
  httpService: {
    defaultTimeout: 30,
    defaultHeaders: {}
  },
  logging: {
    level: "INFO"
  },
  register: {
    mode: RUN_MODES.openaiRegister,
    batchCount: 1,
    verificationCodeWaitTimeout: 60,
    phoneNumberRetryAttempts: 5,
    smsVerificationRetryAttempts: 5,
    oauthReauthWaitThresholdSeconds: 60,
    reusePhoneNumber: true,
    reuseMinIntervalSeconds: 900
  },
  reauthorize: {
    deleteAccountOnDeactivated: false,
    phoneChallengeAction: "stop"
  },
  accountManagementService: {
    provider: "cpa",
    providers: {
      cpa: {
        baseUrl: "http://localhost:8317/v0/management",
        secretKey: ""
      }
    }
  },
  emailService: {
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
  },
  smsService: {
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
  }
});

export function normalizeConfig(config) {
  return deepMerge(DEFAULT_CONFIG, migrateConfig(config || {}));
}

export function getProviderConfig(config, groupName) {
  const group = config[groupName];
  if (!group || !group.provider) {
    return {};
  }
  return group.providers?.[group.provider] || {};
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
  const emailConfig = normalized.emailService.providers.outlook_mail;
  const accountConfig = normalized.accountManagementService.providers.cpa;
  const runMode = normalizeRunMode(normalized.register.mode);
  const accountProfile = getAccountProfileConfig(normalized);
  const batchCount = Number(normalized.register.batchCount);

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
  if (isOpenAiRegisterMode(runMode) && normalized.smsService.provider) {
    const smsConfig = normalized.smsService.providers[normalized.smsService.provider];
    if (normalized.smsService.provider === "manual") {
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
  if (Object.hasOwn(migrated.register || {}, "reuseLocalActivation") && !Object.hasOwn(migrated.register, "reusePhoneNumber")) {
    migrated.register.reusePhoneNumber = migrated.register.reuseLocalActivation;
  }
  if (migrated.register) {
    delete migrated.register.reuseLocalActivation;
    delete migrated.register.waitReusableActivationEnabled;
    delete migrated.register.cleanupSmsActivationHistoryEnabled;
  }
  return migrated;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}
