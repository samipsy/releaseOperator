import { GithubServiceError } from "../errors.js";
import type {
  GithubBranchInput,
  GithubBranchResult,
  GithubPullRequestInput,
  GithubPullRequestRef,
  GithubPullRequestResult,
  GithubPullRequestSnapshot,
  GithubProvider,
  GithubTagBranchInput,
  GithubTagResult,
  GithubCompareInput,
  GithubCommitInfo,
  GithubAssociatedPullRequest,
  GithubPathInput,
  GithubDirEntry,
  GithubFileSnapshot,
  GithubCommitFileInput,
  GithubCommitFileResult,
  GithubPullRequestReview,
} from "./types.js";
import type { McpContentBlock, McpToolCaller } from "../mcp/types.js";

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

function contentsApiPath(path: string): string {
  return encodeURIComponent(path).replaceAll("%2F", "/");
}

/**
 * create_branch and create_pull_request run through the GitHub MCP server (github-mcp-server).
 * tagReleaseBranch, get/update pull request, listCommitsAhead, and latestTagName use GitHub REST
 * (compare/tags/PR body updates are simpler over REST with the same token).
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

  async getPullRequest(input: GithubPullRequestRef): Promise<GithubPullRequestSnapshot> {
    const url = `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/pulls/${input.pullNumber}`;
    const res = await this.fetchImpl(url, { headers: this.restHeaders() });
    const text = await res.text();
    if (!res.ok) {
      throw new GithubServiceError(
        `Could not load pull request #${input.pullNumber} on ${input.owner}/${input.repo}: HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`
      );
    }
    const parsed = tryParseJson(text) ?? {};
    const numberField = parsed.number;
    return {
      number: typeof numberField === "number" ? numberField : input.pullNumber,
      url: firstString(parsed, ["html_url", "url"]),
      title: firstString(parsed, ["title"]),
      body: firstString(parsed, ["body"]),
      raw: text,
    };
  }

  async updatePullRequest(
    input: GithubPullRequestRef & { body?: string; title?: string }
  ): Promise<GithubPullRequestResult> {
    const url = `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/pulls/${input.pullNumber}`;
    const payload: Record<string, string> = {};
    if (input.body !== undefined) payload.body = input.body;
    if (input.title !== undefined) payload.title = input.title;
    const res = await this.fetchImpl(url, {
      method: "PATCH",
      headers: { ...this.restHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new GithubServiceError(
        `Could not update pull request #${input.pullNumber} on ${input.owner}/${input.repo}: HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`
      );
    }
    const parsed = tryParseJson(text);
    const numberField = parsed?.number;
    return {
      url: firstString(parsed, ["html_url", "url"]),
      number: typeof numberField === "number" ? numberField : input.pullNumber,
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

  async listCommitsAhead(input: GithubCompareInput): Promise<GithubCommitInfo[]> {
    const url = `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/compare/${encodeURIComponent(input.base)}...${encodeURIComponent(input.head)}`;
    const res = await this.fetchImpl(url, { headers: this.restHeaders() });
    if (!res.ok) {
      throw new GithubServiceError(
        `Could not compare ${input.base}...${input.head} on ${input.owner}/${input.repo}: HTTP ${res.status} ${res.statusText}`
      );
    }
    const body = (await res.json()) as {
      commits?: {
        sha?: string;
        commit?: { message?: string };
        author?: { login?: string };
      }[];
    };
    const commits: GithubCommitInfo[] = [];
    for (const item of body.commits ?? []) {
      if (typeof item.sha !== "string" || typeof item.commit?.message !== "string") continue;
      const login = item.author?.login;
      commits.push({
        sha: item.sha,
        message: item.commit.message,
        ...(typeof login === "string" && login.length > 0 ? { author: login } : {}),
      });
    }
    return commits;
  }

  async latestTagName(input: { owner: string; repo: string }): Promise<string | undefined> {
    const url = `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/tags?per_page=1`;
    const res = await this.fetchImpl(url, { headers: this.restHeaders() });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { name?: string }[];
    const name = Array.isArray(body) ? body[0]?.name : undefined;
    return typeof name === "string" && name.length > 0 ? name : undefined;
  }

  async readFile(input: GithubPathInput): Promise<string | undefined> {
    const url = `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/contents/${encodeURIComponent(input.path).replaceAll("%2F", "/")}?ref=${encodeURIComponent(input.ref)}`;
    const res = await this.fetchImpl(url, {
      headers: { ...this.restHeaders(), Accept: "application/vnd.github.raw+json" },
    });
    if (res.status === 404) return undefined;
    if (!res.ok) {
      throw new GithubServiceError(
        `Could not read ${input.path} on ${input.owner}/${input.repo}@${input.ref}: HTTP ${res.status} ${res.statusText}`
      );
    }
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as { content?: unknown; encoding?: unknown };
      if (typeof parsed.content === "string" && parsed.encoding === "base64") {
        return Buffer.from(parsed.content, "base64").toString("utf8");
      }
    } catch {
      // GitHub returned raw file text
    }
    return text;
  }

  async readFileMeta(input: GithubPathInput): Promise<GithubFileSnapshot | undefined> {
    const url = `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/contents/${contentsApiPath(input.path)}?ref=${encodeURIComponent(input.ref)}`;
    const res = await this.fetchImpl(url, { headers: this.restHeaders() });
    if (res.status === 404) return undefined;
    const text = await res.text();
    if (!res.ok) {
      throw new GithubServiceError(
        `Could not read ${input.path} on ${input.owner}/${input.repo}@${input.ref}: HTTP ${res.status} ${res.statusText}`
      );
    }
    const parsed = tryParseJson(text);
    const sha = firstString(parsed, ["sha"]);
    const encoding = firstString(parsed, ["encoding"]);
    const content = firstString(parsed, ["content"]);
    if (!sha || !content || encoding !== "base64") {
      throw new GithubServiceError(
        `GitHub Contents for ${input.path} on ${input.owner}/${input.repo}@${input.ref} did not include sha and base64 content`
      );
    }
    return {
      path: firstString(parsed, ["path"]) ?? input.path,
      sha,
      text: Buffer.from(content.replaceAll("\n", ""), "base64").toString("utf8"),
    };
  }

  async commitFile(input: GithubCommitFileInput): Promise<GithubCommitFileResult> {
    const url = `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/contents/${contentsApiPath(input.path)}`;
    const res = await this.fetchImpl(url, {
      method: "PUT",
      headers: { ...this.restHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        message: input.message,
        content: Buffer.from(input.content, "utf8").toString("base64"),
        sha: input.sha,
        branch: input.branch,
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new GithubServiceError(
        `Could not commit ${input.path} on ${input.owner}/${input.repo}@${input.branch}: HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`
      );
    }
    const parsed = tryParseJson(text);
    return {
      sha: firstString(parsed, ["commit.sha", "content.sha", "sha"]),
      url: firstString(parsed, ["commit.html_url", "content.html_url", "html_url"]),
      raw: text,
    };
  }

  async listDirectory(input: GithubPathInput): Promise<GithubDirEntry[]> {
    const url = `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/contents/${encodeURIComponent(input.path).replaceAll("%2F", "/")}?ref=${encodeURIComponent(input.ref)}`;
    const res = await this.fetchImpl(url, { headers: this.restHeaders() });
    if (res.status === 404) return [];
    if (!res.ok) {
      throw new GithubServiceError(
        `Could not list ${input.path} on ${input.owner}/${input.repo}@${input.ref}: HTTP ${res.status} ${res.statusText}`
      );
    }
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return [];
    const entries: GithubDirEntry[] = [];
    for (const item of body) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.name !== "string" || typeof rec.path !== "string") continue;
      entries.push({
        name: rec.name,
        path: rec.path,
        type: rec.type === "dir" ? "dir" : "file",
      });
    }
    return entries;
  }

  async listPullRequestsForCommit(input: {
    owner: string;
    repo: string;
    sha: string;
  }): Promise<GithubAssociatedPullRequest[]> {
    const url = `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/commits/${encodeURIComponent(input.sha)}/pulls`;
    const res = await this.fetchImpl(url, { headers: this.restHeaders() });
    if (res.status === 404) return [];
    if (!res.ok) {
      throw new GithubServiceError(
        `Could not list pull requests for ${input.sha.slice(0, 8)} on ${input.owner}/${input.repo}: HTTP ${res.status} ${res.statusText}`
      );
    }
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return [];
    const pulls: GithubAssociatedPullRequest[] = [];
    for (const item of body) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.number !== "number") continue;
      const title = typeof rec.title === "string" ? rec.title : "";
      const user = rec.user && typeof rec.user === "object" ? (rec.user as Record<string, unknown>).login : undefined;
      const htmlUrl = typeof rec.html_url === "string" ? rec.html_url : undefined;
      pulls.push({
        number: rec.number,
        title,
        ...(typeof user === "string" && user.length > 0 ? { userLogin: user } : {}),
        ...(htmlUrl ? { htmlUrl } : {}),
      });
    }
    return pulls;
  }

  async mergePullRequest(
    input: GithubPullRequestRef & { mergeMethod?: "merge" | "squash" }
  ): Promise<{ merged: boolean; sha?: string; raw: string }> {
    const url = `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/pulls/${input.pullNumber}/merge`;
    const res = await this.fetchImpl(url, {
      method: "PUT",
      headers: { ...this.restHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ merge_method: input.mergeMethod ?? "merge" }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new GithubServiceError(
        `Could not merge pull request #${input.pullNumber} on ${input.owner}/${input.repo}: HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`
      );
    }
    const parsed = tryParseJson(text);
    const sha = firstString(parsed, ["sha"]);
    const merged = parsed?.merged === true;
    return { merged, ...(sha ? { sha } : {}), raw: text };
  }

  async listPullRequestReviews(input: GithubPullRequestRef): Promise<GithubPullRequestReview[]> {
    const url = `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/pulls/${input.pullNumber}/reviews`;
    const res = await this.fetchImpl(url, { headers: this.restHeaders() });
    const text = await res.text();
    if (!res.ok) {
      throw new GithubServiceError(
        `Could not list reviews for pull request #${input.pullNumber} on ${input.owner}/${input.repo}: HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new GithubServiceError(
        `GitHub reviews payload for #${input.pullNumber} on ${input.owner}/${input.repo} was not JSON`
      );
    }
    if (!Array.isArray(parsed)) return [];
    const reviews: GithubPullRequestReview[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const user = rec.user && typeof rec.user === "object" ? (rec.user as Record<string, unknown>).login : undefined;
      const state = typeof rec.state === "string" ? rec.state : "";
      if (typeof user !== "string" || user.length === 0 || !state) continue;
      const body = typeof rec.body === "string" ? rec.body : undefined;
      reviews.push({
        userLogin: user,
        state,
        ...(body ? { body } : {}),
      });
    }
    return reviews;
  }

  private restHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    };
  }
}
