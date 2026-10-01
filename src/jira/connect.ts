import { connectJiraMcp } from "./mcpClient.js";
import { JiraMcpProvider } from "./jiraMcpProvider.js";
import { JiraRestProvider } from "./jiraRestProvider.js";
import { oauthClientConfigFromEnv, JiraOAuthSession } from "./oauthSession.js";
import { readTokenStore, tokenStorePath } from "./tokenStore.js";
import type { JiraProvider } from "./types.js";

export interface ConfiguredJira {
  provider: JiraProvider;
  mode: "oauth" | "mcp";
  close: () => Promise<void>;
  rest?: JiraRestProvider;
}

/**
 * Prefer 3LO tokens from the local store (after `jira login`); fall back to email+API-token MCP.
 */
export async function connectConfiguredJira(): Promise<ConfiguredJira | undefined> {
  const oauthConfig = oauthClientConfigFromEnv();
  const stored = readTokenStore(tokenStorePath());
  if (stored) {
    const session = new JiraOAuthSession({
      ...oauthConfig,
      tokens: stored,
      storePath: tokenStorePath(),
    });
    const snap = session.snapshot();
    const cloudId = process.env.RELEASE_OPERATOR_JIRA_CLOUD_ID ?? snap.cloudId;
    const siteUrl = process.env.RELEASE_OPERATOR_JIRA_SITE ?? snap.siteUrl;
    if (cloudId && siteUrl) {
      const rest = new JiraRestProvider({
        getAccessToken: () => session.getAccessToken(),
        cloudId,
        siteUrl,
      });
      return { provider: rest, mode: "oauth", close: async () => undefined, rest };
    }
  }

  const email = process.env.RELEASE_OPERATOR_JIRA_EMAIL;
  const apiToken = process.env.RELEASE_OPERATOR_JIRA_TOKEN;
  const site = process.env.RELEASE_OPERATOR_JIRA_SITE;
  if (email && apiToken && site) {
    const connection = await connectJiraMcp({
      email,
      apiToken,
      url: process.env.RELEASE_OPERATOR_JIRA_MCP_URL,
    });
    return {
      provider: new JiraMcpProvider({ caller: connection.caller, siteUrl: site }),
      mode: "mcp",
      close: connection.close,
    };
  }

  return undefined;
}
