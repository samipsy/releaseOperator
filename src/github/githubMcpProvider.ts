import { GithubServiceError } from "../errors.js";
import type {
  GithubBranchInput,
  GithubBranchResult,
  GithubPullRequestInput,
  GithubPullRequestResult,
  GithubProvider,
  GithubTagBranchInput,
  GithubTagResult,
  McpContentBlock,
  McpToolCaller,
} from "./types.js";

const GITHUB_API_BASE = "https://api.github.com";
/** Verified current as of 2026-09-14 via docs.github.com/rest/about-the-rest-api/api-versions. */
const GITHUB_API_VERSION = "2026-03-10";

export interface GithubMcpProviderOptions {
  caller: McpToolCaller;
  /** Used only for the direct REST tag-creation fallback (see types.ts for why). */
  token: string;
  fetchImpl?: typeof fetch;
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

/** Looks up a dotted path (e.g. "object.sha") in a plain object, returning it only if it's a string. */
function firstString(obj: Record<string, unknown> | undefined, paths: string[]): string | undefined {
  for (const path of paths) {
    let cur: unknown = obj;
    for (const key of path.split(".")) {
      cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[key] : undefined;
    }
    if (typeof cur === "string") return cur;
  }
  return undefined;
}

/**
 * create_branch and create_pull_request run through the GitHub MCP server (github-mcp-server).
 * tagReleaseBranch does not — that server has no tag/release-creation tool (verified against
 * its full documented tool list), so it falls back to a direct, isolated GitHub REST call
 * using the same token. Everything else in this class goes through MCP.
 */
export class GithubMcpProvider implements GithubProvider {
  private readonly caller: McpToolCaller;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GithubMcpProviderOptions) {
    this.caller = options.caller;
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async callMcpTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.caller.callTool({ name, arguments: args });
    const text = extractText(result.content ?? []);
    if (result.isError) {
      throw new GithubServiceError(`GitHub MCP tool "${name}" reported failure: ${text || "(no details returned)"}`);
    }
    return text;
  }

  async createReleaseBranch(input: GithubBranchInput): Promise<GithubBranchResult> {
    const text = await this.callMcpTool("create_branch", {
      owner: input.owner,
      repo: input.repo,
      branch: input.branch,
      from_branch: input.fromBranch,
    });
    const parsed = tryParseJson(text);
    return {
      ref: firstString(parsed, ["ref", "object.ref"]) ?? `refs/heads/${input.branch}`,
      sha: firstString(parsed, ["object.sha", "sha"]),
      raw: text,
    };
  }

  async createBackmergePullRequest(input: GithubPullRequestInput): Promise<GithubPullRequestResult> {
    const text = await this.callMcpTool("create_pull_request", {
      owner: input.owner,
      repo: input.repo,
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
      draft: input.draft,
    });
    const parsed = tryParseJson(text);
    const numberField = parsed?.number;
    return {
      url: firstString(parsed, ["html_url", "url"]),
      number: typeof numberField === "number" ? numberField : undefined,
      raw: text,
    };
  }

  async tagReleaseBranch(input: GithubTagBranchInput): Promise<GithubTagResult> {
    const branchRes = await this.fetchImpl(
      `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/branches/${encodeURIComponent(input.branch)}`,
      { headers: this.restHeaders() }
    );
    if (!branchRes.ok) {
      throw new GithubServiceError(
        `Could not look up branch "${input.branch}" on ${input.owner}/${input.repo}: HTTP ${branchRes.status} ${branchRes.statusText}`
      );
    }
    const branchBody = (await branchRes.json()) as { commit?: { sha?: string } };
    const sha = branchBody.commit?.sha;
    if (!sha) {
      throw new GithubServiceError(
        `GitHub returned no commit sha for branch "${input.branch}" on ${input.owner}/${input.repo}`
      );
    }

    const refRes = await this.fetchImpl(`${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/git/refs`, {
      method: "POST",
      headers: { ...this.restHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: `refs/tags/${input.tag}`, sha }),
    });
    if (!refRes.ok) {
      const errText = await refRes.text().catch(() => "");
      throw new GithubServiceError(
        `Could not create tag "${input.tag}" on ${input.owner}/${input.repo}: HTTP ${refRes.status} ${refRes.statusText}: ${errText}`
      );
    }
    const refBody = (await refRes.json()) as { ref?: string; object?: { sha?: string } };
    return { ref: refBody.ref, sha: refBody.object?.sha ?? sha, raw: JSON.stringify(refBody) };
  }

  private restHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    };
  }
}
