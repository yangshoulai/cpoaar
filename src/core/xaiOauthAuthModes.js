export const XAI_OAUTH_AUTH_MODES = Object.freeze({
  accountService: "account_service",
  local: "local"
});

export const XAI_OAUTH_AUTH_MODE_LABELS = Object.freeze({
  [XAI_OAUTH_AUTH_MODES.accountService]: "账号服务认证",
  [XAI_OAUTH_AUTH_MODES.local]: "本地认证"
});

export function normalizeXAiOauthAuthMode(value) {
  return value === XAI_OAUTH_AUTH_MODES.local
    ? XAI_OAUTH_AUTH_MODES.local
    : XAI_OAUTH_AUTH_MODES.accountService;
}

export function isLocalXAiOauthAuthMode(value) {
  return normalizeXAiOauthAuthMode(value) === XAI_OAUTH_AUTH_MODES.local;
}
