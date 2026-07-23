import assert from "node:assert/strict";
import test from "node:test";

import { HttpClient } from "../src/core/http.js";

test("HTTP 客户端将调用方指定的缓存策略传给 fetch", async () => {
  const originalFetch = globalThis.fetch;
  let receivedCache = "";
  globalThis.fetch = async (_url, options) => {
    receivedCache = options.cache;
    return new Response("{}", { status: 200 });
  };

  try {
    const client = new HttpClient();
    await client.get("https://example.test/auth-file", { cache: "no-store" });
    assert.equal(receivedCache, "no-store");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
