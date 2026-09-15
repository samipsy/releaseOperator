import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { GithubServiceError } from "../errors.js";
import type { McpToolCaller } from "./types.js";

/**
 * GitHub's own hosted MCP server — "no local setup or runtime required" per
 * github.com/github/github-mcp-server/blob/main/docs/remote-server.md. Confirmed 2026-09-14
 * it accepts plain PAT auth via `Authorization: Bearer <token>` (no OAuth flow needed), so
 * there's no local binary or subprocess to manage — just an HTTP client, same as MLX-LM.
 */
export const DEFAULT_GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";

export interface ConnectGithubMcpOptions {
  token: string;
  /** Override to point at a different toolset URL or a GitHub Enterprise remote server. */
  url?: string;
}

export interface GithubMcpConnection {
  caller: McpToolCaller;
  close(): Promise<void>;
}

export async function connectGithubMcp(options: ConnectGithubMcpOptions): Promise<GithubMcpConnection> {
  const url = options.url ?? DEFAULT_GITHUB_MCP_URL;
  const client = new Client({ name: "release-operator", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${options.token}`,
        // Explicit rather than relying on the server's default toolset — only what we use.
        "X-MCP-Toolsets": "repos,pull_requests",
      },
    },
  });

  try {
    await client.connect(transport);
  } catch (err) {
    throw new GithubServiceError(
      `Could not connect to the GitHub MCP server at ${url}. Check RELEASE_OPERATOR_GITHUB_TOKEN ` +
        `is set and valid. (${(err as Error).message})`,
      err
    );
  }

  return { caller: client, close: () => client.close() };
}
