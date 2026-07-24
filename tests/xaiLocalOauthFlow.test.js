import assert from "node:assert/strict";
import test from "node:test";

import { buildRegisterFlow } from "../src/flow/registerFlowFactory.js";
import { RUN_MODES } from "../src/core/runModes.js";
import { XAiRefreshOAuthAndLoginNode } from "../src/nodes/xaiRefreshOAuthAndLoginNode.js";
import { XAiSubmitConsentNode } from "../src/nodes/xaiSubmitConsentNode.js";

test("xAI 本地 OAuth token 可重试错误会回到刷新 OAuth 节点", () => {
  for (const mode of [RUN_MODES.xaiRegister, RUN_MODES.xaiReauthorize]) {
    const flow = buildRegisterFlow(mode);

    assert.equal(
      flow.findNextNode(XAiSubmitConsentNode.name, { status: XAiSubmitConsentNode.statuses.retryLocalOauth }),
      XAiRefreshOAuthAndLoginNode.name
    );
  }
});
