import { JiraServiceError } from "../errors.js";
import { JIRA_API_PREFIX, adfToPlainText, applyAdfToJiraFields, textToAdf } from "./oauth.js";
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
import { parseServiceRegistryHits } from "./affectedServices.js";

function jiraStatusName(status: unknown): string | undefined {
  if (!status || typeof status !== "object") return undefined;
  const name = (status as Record<string, unknown>).name;
  return typeof name === "string" && name.trim().length > 0 ? name : undefined;
}

export interface JiraRestProviderOptions {
  getAccessToken: () => Promise<string>;
  cloudId: string;
  siteUrl: string;
  fetchImpl?: typeof fetch;
}

/**
 * Jira Cloud REST via Atlassian 3LO (Bearer access token). Used when the operator has
 * completed `jira login`. The MCP provider remains the API-token fallback.
 */
export class JiraRestProvider implements JiraProvider {
  private readonly getAccessToken: () => Promise<string>;
  private readonly cloudId: string;
  private readonly siteUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: JiraRestProviderOptions) {
    this.getAccessToken = options.getAccessToken;
    this.cloudId = options.cloudId;
    this.siteUrl = options.siteUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private apiUrl(path: string): string {
    return `${JIRA_API_PREFIX}/${this.cloudId}/rest/api/3${path}`;
  }

  private async request(path: string, init: RequestInit): Promise<string> {
    const token = await this.getAccessToken();
    let res: Response;
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      };
      if (init.method && init.method !== "GET") headers["Content-Type"] = "application/json";
      res = await this.fetchImpl(this.apiUrl(path), {
        ...init,
        headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      });
    } catch (err) {
      throw new JiraServiceError(`Could not reach Jira REST at ${this.apiUrl(path)}. (${(err as Error).message})`, err);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new JiraServiceError(`Jira REST ${init.method ?? "GET"} ${path} returned HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    return text;
  }

  async createIssue(input: JiraCreateIssueInput): Promise<JiraCreateIssueResult> {
    const fields = applyAdfToJiraFields({
      ...(input.extraFields ?? {}),
      project: { key: input.projectKey },
      summary: input.summary,
      issuetype: { name: input.issueType },
      ...(input.description ? { description: input.description } : {}),
      ...(input.parentKey ? { parent: { key: input.parentKey } } : {}),
    });
    const body = { fields };
    const text = await this.request("/issue", { method: "POST", body: JSON.stringify(body) });
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const key = parseJiraIssueKey(parsed.key, text);
    return {
      key,
      url: key ? `${this.siteUrl}/browse/${key}` : undefined,
      raw: text,
    };
  }

  async addComment(input: JiraCommentInput): Promise<JiraCommentResult> {
    const text = await this.request(`/issue/${encodeURIComponent(input.issueKey)}/comment`, {
      method: "POST",
      body: JSON.stringify({ body: textToAdf(input.body) }),
    });
    return { raw: text };
  }

  async createIssueLink(input: JiraIssueLinkInput): Promise<JiraIssueLinkResult> {
    const text = await this.request("/issueLink", {
      method: "POST",
      body: JSON.stringify({
        type: { name: input.type ?? "Relates" },
        inwardIssue: { key: input.inwardIssue },
        outwardIssue: { key: input.outwardIssue },
      }),
    });
    return { raw: text };
  }

  async getIssue(issueKey: string): Promise<JiraIssueSummary> {
    const text = await this.request(
      `/issue/${encodeURIComponent(issueKey)}?fields=summary,description,status`,
      { method: "GET" }
    );
    const parsed = JSON.parse(text) as {
      key?: string;
      fields?: { summary?: unknown; description?: unknown; status?: unknown };
    };
    const summary = typeof parsed.fields?.summary === "string" ? parsed.fields.summary : "";
    const description = adfToPlainText(parsed.fields?.description);
    const status = jiraStatusName(parsed.fields?.status);
    const key = typeof parsed.key === "string" ? parsed.key : issueKey;
    return {
      key,
      summary,
      url: jiraBrowseUrl(this.siteUrl, key),
      ...(description ? { description } : {}),
      ...(status ? { status } : {}),
    };
  }

  async myself(): Promise<string> {
    return this.request("/myself", { method: "GET" });
  }

  async getMyself(): Promise<{ accountId: string }> {
    const text = await this.myself();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new JiraServiceError(`Jira /myself did not return JSON: ${text.slice(0, 200)}`, err);
    }
    const accountId =
      parsed && typeof parsed === "object" && "accountId" in parsed
        ? (parsed as { accountId?: unknown }).accountId
        : undefined;
    if (typeof accountId !== "string" || accountId.length === 0) {
      throw new JiraServiceError("Jira /myself did not include accountId.");
    }
    return { accountId };
  }

  searchServices = async (query: string): Promise<{ id: string; name?: string }[]> => {
    const path = `/rest/service-registry-api/service?query=${encodeURIComponent(query)}`;
    const url = `${JIRA_API_PREFIX}/${this.cloudId}${path}`;
    const token = await this.getAccessToken();
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new JiraServiceError(
        `Jira service registry query "${query}" returned HTTP ${res.status}: ${text.slice(0, 500)}`
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new JiraServiceError(`Jira service registry did not return JSON: ${text.slice(0, 200)}`, err);
    }
    return parseServiceRegistryHits(parsed);
  }
}
