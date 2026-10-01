export interface JiraCreateIssueInput {
  projectKey: string;
  summary: string;
  issueType: string;
  description?: string;
  /** Parent issue key (team-managed parent / Epic). */
  parentKey?: string;
  /** Extra Jira `fields` entries (custom fields, labels, etc.). */
  extraFields?: Record<string, unknown>;
}

export interface JiraCreateIssueResult {
  key?: string;
  url?: string;
  raw: string;
}

export interface JiraCommentInput {
  issueKey: string;
  body: string;
}

export interface JiraIssueLinkInput {
  /** Feature / related ticket. */
  inwardIssue: string;
  /** PCM Change ticket. */
  outwardIssue: string;
  type?: string;
}

export interface JiraIssueLinkResult {
  raw: string;
}

export interface JiraIssueSummary {
  key: string;
  summary: string;
  description?: string;
  /** Browse URL, e.g. https://ipsycorp.atlassian.net/browse/MET-4257 */
  url?: string;
  /** Workflow status name, e.g. Change Applied. */
  status?: string;
}

export function jiraBrowseUrl(siteUrl: string, issueKey: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/browse/${issueKey}`;
}

const JIRA_ISSUE_KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/;

/** Pulls a KEY-123 out of a create-issue JSON field or free-form MCP text. */
export function parseJiraIssueKey(value: unknown, raw?: string): string | undefined {
  if (typeof value === "string") {
    const matched = value.trim().match(JIRA_ISSUE_KEY);
    if (matched?.[1]) return matched[1];
  }
  if (raw) {
    const matched = raw.match(JIRA_ISSUE_KEY);
    if (matched?.[1]) return matched[1];
  }
  return undefined;
}

/**
 * create + comment. Implementations: JiraRestProvider (Atlassian 3LO) and JiraMcpProvider
 * (email + API token against Atlassian's remote MCP server).
 */
export interface JiraProvider {
  createIssue(input: JiraCreateIssueInput): Promise<JiraCreateIssueResult>;
  addComment(input: JiraCommentInput): Promise<JiraCommentResult>;
  getIssue(issueKey: string): Promise<JiraIssueSummary>;
  /** Logged-in Jira account (3LO /myself). Used as reporter and assignee. */
  getMyself?(): Promise<{ accountId: string }>;
  /** JSM service registry search for Affected services. */
  searchServices?(query: string): Promise<{ id: string; name?: string }[]>;
  /** Linked work items (PCM Change “relates to” release tickets). */
  createIssueLink?(input: JiraIssueLinkInput): Promise<JiraIssueLinkResult>;
}
