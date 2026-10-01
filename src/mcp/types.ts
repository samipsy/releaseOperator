/**
 * The minimal surface of an MCP client any provider in this codebase needs. The real
 * implementations (src/github/mcpClient.ts, src/jira/mcpClient.ts) are backed by
 * @modelcontextprotocol/client's Client, which is structurally compatible with this
 * interface — tests inject a fake instead of a real connection.
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
