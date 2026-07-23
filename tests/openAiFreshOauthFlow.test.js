import assert from "node:assert/strict";
import test from "node:test";

import { buildRegisterFlow, getNodeOrder } from "../src/flow/registerFlowFactory.js";
import { OPENAI_REGISTER_FLOWS } from "../src/core/openAiRegisterFlows.js";
import { RUN_MODES } from "../src/core/runModes.js";
import { FillAboutYouNode } from "../src/nodes/fillAboutYouNode.js";
import { ResetOpenAiSessionForOAuthNode } from "../src/nodes/resetOpenAiSessionForOAuthNode.js";
import { SelectCodexAccountNode } from "../src/nodes/selectCodexAccountNode.js";
import { SubmitCodexConsentNode } from "../src/nodes/submitCodexConsentNode.js";
import { WaitEmailVerificationCodeNode } from "../src/nodes/waitEmailVerificationCodeNode.js";
import { WaitSmsVerificationCodeNode } from "../src/nodes/waitSmsVerificationCodeNode.js";

test("邮箱优先 OpenAI 注册在导出前强制刷新 OAuth 并验证邮箱", () => {
  const flow = buildRegisterFlow(RUN_MODES.openaiRegister, {
    openAiRegisterFlow: OPENAI_REGISTER_FLOWS.emailFirst
  });

  assert.equal(
    flow.findNextNode(FillAboutYouNode.name, { status: FillAboutYouNode.statuses.success }),
    ResetOpenAiSessionForOAuthNode.name
  );
  assert.equal(
    flow.findNextNode(ResetOpenAiSessionForOAuthNode.name, { status: ResetOpenAiSessionForOAuthNode.statuses.success }),
    SelectCodexAccountNode.name
  );
  assert.equal(
    flow.findNextNode(WaitEmailVerificationCodeNode.name, { status: WaitEmailVerificationCodeNode.statuses.consent }),
    ResetOpenAiSessionForOAuthNode.name
  );
  assert.equal(
    flow.findNextNode(WaitEmailVerificationCodeNode.name, { status: WaitEmailVerificationCodeNode.statuses.freshOauthConsent }),
    SubmitCodexConsentNode.name
  );
  assert.equal(
    flow.findNextNode(SelectCodexAccountNode.name, { status: SelectCodexAccountNode.statuses.freshOauthConsent }),
    SubmitCodexConsentNode.name
  );
  assert.equal(
    flow.findNextNode(WaitSmsVerificationCodeNode.name, { status: WaitSmsVerificationCodeNode.statuses.freshOauthConsent }),
    SubmitCodexConsentNode.name
  );
});

test("手机号优先 OpenAI 注册同样在导出前走新的 OAuth 邮箱验证", () => {
  const options = { openAiRegisterFlow: OPENAI_REGISTER_FLOWS.phoneFirst };
  const flow = buildRegisterFlow(RUN_MODES.openaiRegister, options);
  const nodeOrder = getNodeOrder(RUN_MODES.openaiRegister, options);

  assert.equal(nodeOrder.includes(ResetOpenAiSessionForOAuthNode.name), true);
  assert.equal(
    flow.findNextNode(SelectCodexAccountNode.name, { status: SelectCodexAccountNode.statuses.consent }),
    ResetOpenAiSessionForOAuthNode.name
  );
  assert.equal(
    flow.findNextNode(WaitEmailVerificationCodeNode.name, { status: WaitEmailVerificationCodeNode.statuses.freshOauthConsent }),
    SubmitCodexConsentNode.name
  );
});
