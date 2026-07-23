import assert from "node:assert/strict";
import test from "node:test";

import { finalizeLocalHistoryAfterAccountDeletion } from "../src/services/accountDeletionService.js";

test("重新授权删除远端账号时保留本地历史记录", async () => {
  let deletedHistoryId = "";
  const result = await finalizeLocalHistoryAfterAccountDeletion({
    id: "history-1",
    emailAddress: "user@example.com"
  }, {
    preserveLocalHistory: true,
    deleteHistory: async (id) => {
      deletedHistoryId = id;
    }
  });

  assert.deepEqual(result, { preserved: true, deleted: false });
  assert.equal(deletedHistoryId, "");
});

test("未要求保留时维持既有的本地历史删除行为", async () => {
  let deletedHistoryId = "";
  const result = await finalizeLocalHistoryAfterAccountDeletion({
    id: "history-2",
    emailAddress: "user@example.com"
  }, {
    deleteHistory: async (id) => {
      deletedHistoryId = id;
    }
  });

  assert.deepEqual(result, { preserved: false, deleted: true });
  assert.equal(deletedHistoryId, "history-2");
});
