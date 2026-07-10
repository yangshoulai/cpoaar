import { RegisterNode, NodeResult } from "../core/flow.js";
import { waitForAnyCondition } from "../core/browser.js";
import { createLogger } from "../core/logger.js";
import { ACCOUNT_TYPES } from "../core/runModes.js";
import { findVisibleButtonByText } from "./xaiHelpers.js";

const logger = createLogger("node.xai-oauth");

export class XAiRefreshOAuthAndLoginNode extends RegisterNode {
  static name = "xai_refresh_oauth_and_login";
  static statuses = {
    consent: "xai_oauth_consent_ready"
  };

  constructor() {
    super(XAiRefreshOAuthAndLoginNode.name, "刷新 xAI OAuth 并登录");
  }

  async execute(ctx) {
    let oauth;
    try {
      oauth = await ctx.services.accountManagementService.getOauthUrl({
        accountType: ACCOUNT_TYPES.xai
      });
    } catch (error) {
      return NodeResult.fail("xai_oauth_request_failed", formatServiceError(error));
    }
    ctx.state.xaiOauthUrl = oauth;
    await ctx.tabs.navigate(oauth.url);

    const consentResult = await waitForAnyCondition([
      {
        name: "consent_url",
        check: () => ctx.tabs.urlContains("/oauth2/consent")
      },
      {
        name: "allow_button",
        check: () => findVisibleButtonByText(ctx, ["允许", "allow", "authorize"])
      }
    ], {
      timeoutMs: 30000,
      label: "xAI OAuth consent 页面",
      signal: ctx.signal
    });
    if (!consentResult.matched) {
      return NodeResult.fail("xai_oauth_unexpected_url", `访问 xAI OAuth 后未进入 consent 页面: ${await ctx.tabs.getCurrentUrl()}`);
    }

    logger.info("xAI OAuth consent 已就绪", {
      currentUrl: await ctx.tabs.getCurrentUrl()
    });
    return NodeResult.ok(XAiRefreshOAuthAndLoginNode.statuses.consent, {
      xaiOauthUrl: oauth,
      currentUrl: await ctx.tabs.getCurrentUrl()
    });
  }
}

function formatServiceError(error) {
  const message = `${error.name}: ${error.message}`;
  if (error.url) {
    return `${message}；URL=${error.url}`;
  }
  return message;
}
