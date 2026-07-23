import assert from "node:assert/strict";
import test from "node:test";

import {
  containsPageText,
  findPageTextMatch,
  getPageTextTerms,
  normalizePageText
} from "../src/core/pageText.js";

test("中英文注册与登录文案命中相同语义", () => {
  assert.equal(containsPageText("使用邮箱注册", "xaiEmailEntry"), true);
  assert.equal(containsPageText("Sign in with email", "xaiEmailSignIn"), true);
  assert.equal(containsPageText("Complete registration", "xaiCompleteRegistration"), true);
  assert.equal(containsPageText("完成注册", "xaiCompleteRegistration"), true);
});

test("文本规范化处理英文大小写、全角字符和空白", () => {
  assert.equal(normalizePageText("  SIGN　IN   WITH EMAIL  "), "sign in with email");
  assert.equal(containsPageText("  SIGN IN   WITH EMAIL ", "xaiEmailSignIn"), true);
});

test("中文与英文验证码、短信错误均可识别", () => {
  assert.equal(containsPageText("代码不正确", "invalidVerificationCode"), true);
  assert.equal(containsPageText("The code is incorrect", "invalidVerificationCode"), true);
  assert.equal(containsPageText("无法向此电话号码发送文本消息", "smsSendFailed"), true);
  assert.equal(containsPageText("We can't send text messages to this phone number", "smsSendFailed"), true);
});

test("许可与拒绝文案分别保留，供按钮选择器排除反向操作", () => {
  assert.equal(containsPageText("允许继续", "consentAllow"), true);
  assert.equal(containsPageText("Don't allow", "consentDeny"), true);
  assert.equal(findPageTextMatch("请继续通过 WhatsApp 发送验证码", "phoneRetryableError"), "请继续通过 WhatsApp 发送验证码");
  assert.equal(getPageTextTerms("consentAllow").includes("允许"), true);
});
