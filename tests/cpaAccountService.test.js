import assert from "node:assert/strict";
import test from "node:test";

import { CpaAccountService, buildCodexAuthFileNames } from "../src/services/cpaAccountService.js";
import { ACCOUNT_TYPES } from "../src/core/runModes.js";

globalThis.chrome = {
  storage: {
    local: {
      get: async () => ({}),
      set: async () => {}
    }
  },
  runtime: {
    sendMessage: () => Promise.resolve()
  }
};

test("OpenAI 删除依次尝试所有历史认证文件名", async () => {
  const emailAddress = "user@example.com";
  const requestedNames = [];
  const http = {
    request: async (_url, options) => {
      const fileName = options.query.name;
      requestedNames.push(fileName);
      if (fileName === `codex-${emailAddress}-free.json`) {
        const error = new Error("server error");
        error.status = 500;
        throw error;
      }
      if (fileName === `${emailAddress}.json`) {
        const error = new Error("not found");
        error.status = 404;
        throw error;
      }
      return { status: "ok" };
    }
  };
  const service = new CpaAccountService({ baseUrl: "https://cpa.example", secretKey: "key" }, http, {
    accountType: ACCOUNT_TYPES.openai
  });

  const result = await service.deleteAccount({ emailAddress, accountType: ACCOUNT_TYPES.openai });

  assert.deepEqual(requestedNames, buildCodexAuthFileNames(emailAddress));
  assert.equal(result.success, true);
  assert.deepEqual(result.deletedFiles, [`codex-${emailAddress}.json`]);
  assert.deepEqual(result.missingFiles, [`${emailAddress}.json`]);
  assert.deepEqual(result.failedFiles, [`codex-${emailAddress}-free.json`]);
});
