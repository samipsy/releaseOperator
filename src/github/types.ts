/**
 * The minimal surface of an MCP client this module needs. The real implementation
 * (src/github/mcpClient.ts) is backed by @modelcontextprotocol/client's Client, which is
 * structurally compatible with this interface — tests inject a fake instead.
 */
export interface McpContentBlock {
  type: string;
  text?: string;
}

export interface McpToolCallResult {
  content: McpContentBlock[];
  isError?: boolean;
}

export interface McpToolCaller {
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<McpToolCallResult>;
}

export interface GithubBranchInput {
  owner: string;
  repo: string;
  branch: string;
  fromBranch?: string;
}

export interface GithubBranchResult {
  ref?: string;
  sha?: string;
  raw: string;
}

export interface GithubPullRequestInput {
  owner: string;
  repo: string;
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
}

export interface GithubPullRequestResult {
  url?: string;
  number?: number;
  raw: string;
}

export interface GithubTagBranchInput {
  owner: string;
  repo: string;
  /** The branch whose current HEAD commit will be tagged. */
  branch: string;
  tag: string;
}

export interface GithubTagResult {
  ref?: string;
  sha?: string;
  raw: string;
}

/**
 * create_branch and create_pull_request go through the GitHub MCP server. Tagging does not:
 * github-mcp-server has no tool to create a git tag or release (verified against its full
 * tool list on 2026-09-14 — only read-only get_tag/list_tags/get_release_by_tag exist), so
 * tagReleaseBranch falls back to a direct, isolated REST call. See githubMcpProvider.ts.
 */
export interface GithubProvider {
  createReleaseBranch(input: GithubBranchInput): Promise<GithubBranchResult>;
  createBackmergePullRequest(input: GithubPullRequestInput): Promise<GithubPullRequestResult>;
  tagReleaseBranch(input: GithubTagBranchInput): Promise<GithubTagResult>;
}
