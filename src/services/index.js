import { HttpClient } from "../core/http.js";
import { getProviderConfig } from "../core/config.js";
import { createAccount } from "../core/account.js";
import { SmsActivationStore } from "./smsActivationStore.js";
import { CpaAccountExportService } from "./cpaAccountExportService.js";
import { OutlookMailEmailService } from "./outlookMailService.js";
import { HeroSmsService } from "./heroSmsService.js";
import { SmsBowerService } from "./smsBowerService.js";

export function createServices(config) {
  const httpClient = new HttpClient(config.httpService);
  const activationStore = new SmsActivationStore();
  const smsProvider = config.smsService.provider;
  const smsConfig = smsProvider ? config.smsService.providers[smsProvider] : null;
  const activationStoreConfig = buildActivationStoreConfig(config);

  return {
    config,
    httpClient,
    activationStore,
    accountService: {
      createAccount: () => createAccount(config.accountService)
    },
    emailService: new OutlookMailEmailService(
      getProviderConfig(config, "emailService"),
      httpClient
    ),
    accountExportService: new CpaAccountExportService(
      getProviderConfig(config, "accountExportService"),
      httpClient
    ),
    smsService: smsProvider
      ? createSmsService(smsProvider, smsConfig, httpClient, activationStore, activationStoreConfig)
      : null
  };
}

function buildActivationStoreConfig(config) {
  return {
    reusePhoneNumber: config.register.reusePhoneNumber ?? true,
    reuseMinIntervalSeconds: config.register.reuseMinIntervalSeconds ?? 900
  };
}

function createSmsService(provider, providerConfig, httpClient, activationStore, activationStoreConfig) {
  provider = normalizeSmsProvider(provider);
  if (provider === "hero_sms") {
    return new HeroSmsService(providerConfig, httpClient, activationStore, activationStoreConfig);
  }
  if (provider === "sms_bower" || provider === "smsbower") {
    return new SmsBowerService(providerConfig, httpClient, activationStore, activationStoreConfig);
  }
  throw new Error(`不支持的短信服务: ${provider}`);
}

function normalizeSmsProvider(provider) {
  if (provider === "smsbower") {
    return "sms_bower";
  }
  return provider;
}
