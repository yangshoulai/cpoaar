export const OPENAI_REGISTER_FLOWS = Object.freeze({
  emailFirst: "email_first",
  phoneFirst: "phone_first_email"
});

const LEGACY_OPENAI_REGISTER_FLOW_MAP = Object.freeze({
  default: OPENAI_REGISTER_FLOWS.emailFirst,
  email: OPENAI_REGISTER_FLOWS.emailFirst,
  email_first: OPENAI_REGISTER_FLOWS.emailFirst,
  phone_first: OPENAI_REGISTER_FLOWS.phoneFirst,
  phone_first_email: OPENAI_REGISTER_FLOWS.phoneFirst
});

export function normalizeOpenAiRegisterFlow(value) {
  const normalized = LEGACY_OPENAI_REGISTER_FLOW_MAP[value] || value || OPENAI_REGISTER_FLOWS.emailFirst;
  return Object.values(OPENAI_REGISTER_FLOWS).includes(normalized)
    ? normalized
    : OPENAI_REGISTER_FLOWS.emailFirst;
}

export function isOpenAiPhoneFirstRegisterFlow(value) {
  return normalizeOpenAiRegisterFlow(value) === OPENAI_REGISTER_FLOWS.phoneFirst;
}
