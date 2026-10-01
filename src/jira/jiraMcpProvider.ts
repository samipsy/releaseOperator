import { JiraServiceError } from "../errors.js";
import { adfToPlainText } from "./oauth.js";
import {
  jiraBrowseUrl,
  parseJiraIssueKey,
  type JiraCommentInput,
  type JiraCommentResult,
  type JiraCreateIssueInput,
  type JiraCreateIssueResult,
  type JiraIssueLinkInput,
  type JiraIssueLinkResult,
  type JiraIssueSummary,
  type JiraProvider,
} from "./types.js";
import type { McpContentBlock, McpToolCaller } from "../mcp/types.js";

export interface JiraMcpProviderOptions {
  caller: McpToolCaller;
  /** Your Jira Cloud site, e.g. "https://ipsycorp.atlassian.net" — used to resolve cloudId. */
  siteUrl: string;
}

function extractText(content: McpContentBlock[]): string {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

function tryParseJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function firstValue(obj: Record<string, unknown> | undefined, paths: string[]): unknown {
  for (const path of paths) {
    let cur: unknown = obj;
    for (const key of path.split(".")) {
      cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[key] : undefined;
    }
    if (cur !== undefined) return cur;
  }
  return undefined;
}

function normalizeSiteUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/^https?:\/\//, "").toLowerCase();
}

interface AtlassianResource {
  cloudId?: string;
  url?: string;
  products?: { id: string }[];
}

/**
 * Talks to Atlassian's remote MCP server (see mcpClient.ts). Every Jira tool call requires a
 * cloudId — resolved once via getAccessibleAtlassianResources by matching the configured site
 * URL, then cached for the life of this instance (per Atlassian's own guidance: call it once
 * per session, never per-call).
 */
export class JiraMcpProvider implements JiraProvider {
  private readonly caller: McpToolCaller;
  private readonly siteUrl: string;
  private cloudId: string | undefined;

  constructor(options: JiraMcpProviderOptions) {
    this.caller = options.caller;
    this.siteUrl = options.siteUrl;
  }

  private async callMcpTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.caller.callTool({ name, arguments: args });
    const text = extractText(result.content ?? []);
    if (result.isError) {
      throw new JiraServiceError(`Jira MCP tool "${name}" reported failure: ${text || "(no details returned)"}`);
    }
    return text;
  }

  private async resolveCloudId(): Promise<string> {
    if (this.cloudId) return this.cloudId;

    const text = await this.callMcpTool("getAccessibleAtlassianResources", {});
    const parsed = tryParseJson(text);
    const resources = (firstValue(parsed, ["data.resources", "resources"]) as AtlassianResource[] | undefined) ?? [];

    const wanted = normalizeSiteUrl(this.siteUrl);
    const match = resources.find((r) => typeof r.url === "string" && normalizeSiteUrl(r.url) === wanted);

    if (!match?.cloudId) {
      const available = resources.map((r) => r.url).filter(Boolean).join(", ") || "(none)";
      throw new JiraServiceError(
        `No accessible Atlassian site matched "${this.siteUrl}". Sites available to this account: ${available}`
      );
    }
    if (!match.products?.some((p) => p.id === "jira")) {
      throw new JiraServiceError(`Site "${this.siteUrl}" is accessible but has no Jira product access for this account.`);
    }

    this.cloudId = match.cloudId;
    return this.cloudId;
  }

  async createIssue(input: JiraCreateIssueInput): Promise<JiraCreateIssueResult> {
    const cloudId = await this.resolveCloudId();
    const text = await this.callMcpTool("createJiraIssue", {
      cloudId,
      projectKey: input.projectKey,
      summary: input.summary,
      issueType: input.issueType,
      description: input.description,
      ...(input.parentKey ? { parent: input.parentKey } : {}),
    });
    const parsed = tryParseJson(text);
    const keyStr = parseJiraIssueKey(firstValue(parsed, ["data.key", "key", "issueKey", "issue.key"]), text);
    return {
      key: keyStr,
      url: keyStr ? `${this.siteUrl.replace(/\/+$/, "")}/browse/${keyStr}` : undefined,
      raw: text,
    };
  }

  async addComment(input: JiraCommentInput): Promise<JiraCommentResult> {
    const cloudId = await this.resolveCloudId();
    const text = await this.callMcpTool("addOrEditJiraIssueComment", {
      cloudId,
      issueIdOrKey: input.issueKey,
      commentBody: input.body,
    });
    return { raw: text };
  }

  async createIssueLink(input: JiraIssueLinkInput): Promise<JiraIssueLinkResult> {
    const cloudId = await this.resolveCloudId();
    const text = await this.callMcpTool("createIssueLink", {
      cloudId,
      inwardIssue: input.inwardIssue,
      outwardIssue: input.outwardIssue,
      type: input.type ?? "Relates",
    });
    return { raw: text };
  }

  async getIssue(issueKey: string): Promise<JiraIssueSummary> {
    const cloudId = await this.resolveCloudId();
    const text = await this.callMcpTool("getJiraIssue", {
      cloudId,
      issueIdOrKey: issueKey,
      fields: ["summary", "description", "status"],
    });
    const parsed = tryParseJson(text);
    const key = firstValue(parsed, ["key", "data.key"]);
    const summary = firstValue(parsed, ["fields.summary", "data.fields.summary", "summary"]);
    const description = adfToPlainText(firstValue(parsed, ["fields.description", "data.fields.description", "description"]));
    const statusRaw = firstValue(parsed, ["fields.status.name", "data.fields.status.name", "status.name", "status"]);
    const status = typeof statusRaw === "string" ? statusRaw : undefined;
    const keyStr = typeof key === "string" ? key : issueKey;
    return {
      key: keyStr,
      summary: typeof summary === "string" ? summary : "",
      url: jiraBrowseUrl(this.siteUrl, keyStr),
      ...(description ? { description } : {}),
      ...(status ? { status } : {}),
    };
  }
}
