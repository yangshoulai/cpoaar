const PAGE_TEXT = Object.freeze({
  emailFieldHint: [
    "邮箱",
    "电子邮件",
    "邮件地址",
    "email",
    "e-mail",
    "email address"
  ],
  signUp: [
    "注册",
    "创建账号",
    "创建帐户",
    "sign up",
    "signup",
    "create account",
    "get started"
  ],
  primarySubmit: [
    "继续",
    "下一步",
    "提交",
    "注册",
    "continue",
    "next",
    "submit",
    "sign up"
  ],
  xaiEmailEntry: [
    "使用邮箱注册",
    "使用邮箱登录",
    "使用电子邮件登录",
    "sign up with email",
    "sign in with email",
    "log in with email",
    "login with email",
    "continue with email",
    "use email"
  ],
  xaiEmailSignIn: [
    "使用邮箱登录",
    "使用电子邮件登录",
    "sign in with email",
    "log in with email",
    "login with email",
    "continue with email",
    "use email"
  ],
  xaiEmailEntryExclude: [
    "使用邮箱注册",
    "使用邮箱登录",
    "使用电子邮件登录",
    "with email",
    "use email"
  ],
  xaiEmailSubmit: [
    "注册",
    "继续",
    "sign up",
    "continue"
  ],
  xaiSignInSubmit: [
    "下一步",
    "登录",
    "继续",
    "next",
    "sign in",
    "log in",
    "login",
    "continue"
  ],
  xaiCompleteRegistration: [
    "完成注册",
    "注册",
    "complete registration",
    "sign up"
  ],
  xaiConfirmEmail: [
    "确认邮箱",
    "确认电子邮件",
    "确认",
    "confirm email",
    "verify email",
    "confirm"
  ],
  consentAllow: [
    "允许",
    "同意",
    "授权",
    "allow",
    "authorize",
    "approve",
    "accept",
    "consent"
  ],
  consentDeny: [
    "不允许",
    "不同意",
    "拒绝",
    "取消",
    "don't allow",
    "do not allow",
    "deny",
    "decline",
    "reject",
    "cancel",
    "not now"
  ],
  continueAction: [
    "继续",
    "下一步",
    "continue",
    "next"
  ],
  xaiDeviceLoginTitle: [
    "登录 Grok Build",
    "登录到 Grok Build",
    "login grok build",
    "sign in to grok build"
  ],
  phoneContinue: [
    "使用电话号码继续",
    "电话号码继续",
    "使用手机号继续",
    "手机号继续",
    "continue with phone number",
    "continue with phone",
    "use phone number"
  ],
  phoneOtpSelectChannel: [
    "验证您的手机号码",
    "verify your phone number"
  ],
  phoneVerificationPrompt: [
    "查看你的手机",
    "查看您的手机",
    "check your phone"
  ],
  oneTimeCodeLogin: [
    "一次性验证码",
    "验证码登录",
    "使用验证码",
    "one-time code",
    "one time code",
    "use a one-time code",
    "sign in with a one-time code",
    "log in with a one-time code",
    "continue with a one-time code"
  ],
  accountCreateFailed: [
    "无法创建你的帐户",
    "无法创建你的账户",
    "unable to create your account",
    "couldn't create your account",
    "could not create your account"
  ],
  invalidVerificationCode: [
    "代码不正确",
    "验证码不正确",
    "incorrect code",
    "invalid code",
    "the code is incorrect",
    "the code you entered is incorrect"
  ],
  chatGptReady: [
    "你已准备就绪",
    "you're all set",
    "you are all set"
  ],
  useBirthDate: [
    "使用出生日期",
    "use date of birth",
    "use your date of birth"
  ],
  phoneAccountExists: [
    "与此电话号码相关联的帐户已存在",
    "与此电话号码相关联的账户已存在",
    "与该电话号码相关联的帐户已存在",
    "与该电话号码相关联的账户已存在",
    "an account already exists with this phone number",
    "an account associated with this phone number already exists",
    "account already exists for this phone number"
  ],
  phoneRetryableError: [
    "电话号码已被使用",
    "电话号码无效",
    "请继续通过 WhatsApp 发送验证码",
    "通过 WhatsApp 向该号码发送一次性验证码",
    "此电话号码已关联到可关联的最多账户",
    "phone number is already in use",
    "this phone number is already in use",
    "phone number is invalid",
    "this phone number is invalid",
    "continue with WhatsApp to receive a verification code",
    "use WhatsApp to receive a verification code",
    "send a one-time code to this number via WhatsApp",
    "this phone number has reached the maximum number of associated accounts",
    "this phone number is already associated with the maximum number of accounts"
  ],
  phoneRecentlyUsed: [
    "此电话号码近期已被使用。请稍后再试。",
    "此电话号码最近已被使用",
    "this phone number was recently used. please try again later.",
    "this phone number was recently used",
    "phone number was recently used"
  ],
  whatsAppCodeNotice: [
    "我们会通过 WhatsApp 向该号码发送一次性验证码进行验证",
    "通过 WhatsApp 向该号码发送一次性验证码",
    "WhatsApp 向该号码发送一次性验证码",
    "send a one-time code to this number via WhatsApp",
    "send a one-time code via WhatsApp"
  ],
  smsSendFailed: [
    "无法向此电话号码发送文本消息",
    "无法向该电话号码发送文本消息",
    "无法发送文本消息",
    "无法发送短信",
    "can't send text messages to this phone number",
    "can't send a text message to this phone number",
    "cannot send text messages to this phone number",
    "unable to send text messages to this phone number",
    "unable to send a text message to this phone number",
    "we can't send text messages to this phone number",
    "we can’t send text messages to this phone number"
  ],
  whatsAppResend: [
    "重新发送 WhatsApp 消息",
    "重新发送 WhatsApp",
    "resend WhatsApp message",
    "resend WhatsApp"
  ]
});

export function getPageTextTerms(name) {
  const terms = PAGE_TEXT[name];
  if (!terms) {
    throw new Error(`未定义页面文本语义: ${name}`);
  }
  return [...terms];
}

export function normalizePageText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function containsPageText(value, name) {
  const normalizedValue = normalizePageText(value);
  return getPageTextTerms(name).some((term) => normalizedValue.includes(normalizePageText(term)));
}

export function findPageTextMatch(value, name) {
  const normalizedValue = normalizePageText(value);
  return getPageTextTerms(name)
    .find((term) => normalizedValue.includes(normalizePageText(term))) || "";
}

export { PAGE_TEXT };
