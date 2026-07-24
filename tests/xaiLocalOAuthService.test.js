import assert from "node:assert/strict";
import test from "node:test";

import { XAiLocalOAuthService, XAI_LOCAL_AUTH_FILE_HEADERS } from "../src/services/xaiLocalOAuthService.js";

function buildUnsignedJwt(payload) {
  const header = base64UrlEncode(JSON.stringify({ alg: "none", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(payload));
  return `${header}.${body}.`;
}

function base64UrlEncode(value) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

test("xAI 本地 OAuth token 可组装为 CPA 认证文件", () => {
  const service = new XAiLocalOAuthService({});
  const idToken = buildUnsignedJwt({
    sub: "user-sub-1",
    email: "token@example.com"
  });

  const authFile = service.buildAuthFile({
    access_token: buildUnsignedJwt({ sub: "access-sub" }),
    refresh_token: "refresh-token",
    id_token: idToken,
    token_type: "Bearer",
    expires_in: 21600
  }, {
    emailAddress: "User@Example.com",
    tokenEndpoint: "https://auth.x.ai/oauth2/token"
  });

  assert.equal(authFile.type, "xai");
  assert.equal(authFile.email, "User@Example.com");
  assert.equal(authFile.sub, "user-sub-1");
  assert.equal(authFile.base_url, "https://cli-chat-proxy.grok.com/v1");
  assert.equal(authFile.token_endpoint, "https://auth.x.ai/oauth2/token");
  assert.equal(authFile.auth_kind, "oauth");
  assert.equal(authFile.expires_in, 21600);
  assert.match(authFile.last_refresh, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.deepEqual(authFile.headers, XAI_LOCAL_AUTH_FILE_HEADERS);
});
