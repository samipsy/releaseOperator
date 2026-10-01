import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { JiraServiceError } from "../errors.js";
import type { McpToolCaller } from "../mcp/types.js";

/** Atlassian's own hosted MCP server. Verified 2026-09-15. */
export const DEFAULT_JIRA_MCP_URL = "https://mcp.atlassian.com/v2/mcp";

export interface ConnectJiraMcpOptions {
  email: string;
  apiToken: string;
  url?: string;
}

export interface JiraMcpConnection {
  caller: McpToolCaller;
  close(): Promise<void>;
}

/**
 * Connects to Atlassian's hosted remote MCP server over HTTP, same "no local process" shape
 * as the GitHub integration. Auth is non-interactive Basic (base64 email:api_token) — verified
 * live against a real Jira Cloud site that this supports both read AND write tools
 * (createJiraIssue, editJiraIssue, addOrEditJiraIssueComment), contrary to Atlassian's own docs
 * being vague about write support under this auth mode. Atlassian notes an org admin must have
 * enabled non-interactive API-token auth; if that's ever disabled, this call fails clearly.
 */
export async function connectJiraMcp(options: ConnectJiraMcpOptions): Promise<JiraMcpConnection> {
  const url = options.url ?? DEFAULT_JIRA_MCP_URL;
  const basic = Buffer.from(`${options.email}:${options.apiToken}`).toString("base64");
  const client = new Client({ name: "release-operator", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Basic ${basic}` } },
  });

  try {
    await client.connect(transport);
  } catch (err) {
    throw new JiraServiceError(
      `Could not connect to the Atlassian MCP server at ${url}. Check RELEASE_OPERATOR_JIRA_EMAIL ` +
        `and RELEASE_OPERATOR_JIRA_TOKEN are set and valid, and that non-interactive API-token auth ` +
        `is enabled for your Atlassian org. (${(err as Error).message})`,
      err
    );
  }

  return { caller: client, close: () => client.close() };
}
