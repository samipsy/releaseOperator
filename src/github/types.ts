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

export interface GithubPullRequestRef {
  owner: string;
  repo: string;
  pullNumber: number;
}

export interface GithubPullRequestSnapshot {
  number: number;
  url?: string;
  title?: string;
  body?: string;
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

export interface GithubCommitInfo {
  sha: string;
  message: string;
  /** GitHub login when the compare API includes `author.login`. */
  author?: string;
}

export interface GithubAssociatedPullRequest {
  number: number;
  title: string;
  userLogin?: string;
  htmlUrl?: string;
}

export interface GithubCompareInput {
  owner: string;
  repo: string;
  /** Branch or tag that is already released (usually main). */
  base: string;
  /** Branch that contains the release (usually release/<version>). */
  head: string;
}

export interface GithubPathInput {
  owner: string;
  repo: string;
  path: string;
  /** Branch, tag, or commit SHA. */
  ref: string;
}

export interface GithubDirEntry {
  name: string;
  path: string;
  type: "file" | "dir";
}

export interface GithubFileSnapshot {
  path: string;
  text: string;
  sha: string;
}

export interface GithubCommitFileInput {
  owner: string;
  repo: string;
  path: string;
  branch: string;
  content: string;
  message: string;
  /** Blob SHA of the file being replaced (required by the Contents API). */
  sha: string;
}

export interface GithubCommitFileResult {
  sha?: string;
  url?: string;
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
  getPullRequest(input: GithubPullRequestRef): Promise<GithubPullRequestSnapshot>;
  updatePullRequest(
    input: GithubPullRequestRef & { body?: string; title?: string }
  ): Promise<GithubPullRequestResult>;
  tagReleaseBranch(input: GithubTagBranchInput): Promise<GithubTagResult>;
  /**
   * Commits on `head` that are not on `base` (GitHub compare base...head).
   * Used to list work in the release branch vs main.
   */
  listCommitsAhead(input: GithubCompareInput): Promise<GithubCommitInfo[]>;
  /** Newest tag name, if any — fallback base when the release branch equals main. */
  latestTagName(input: { owner: string; repo: string }): Promise<string | undefined>;
  /** File text at path/ref, or undefined if the path does not exist. */
  readFile(input: GithubPathInput): Promise<string | undefined>;
  /** File text and blob SHA at path/ref, or undefined if missing. */
  readFileMeta(input: GithubPathInput): Promise<GithubFileSnapshot | undefined>;
  /** Create or update a file on a branch (GitHub Contents PUT — commits and pushes). */
  commitFile(input: GithubCommitFileInput): Promise<GithubCommitFileResult>;
  /** Directory listing at path/ref. Empty if the path is missing or is a file. */
  listDirectory(input: GithubPathInput): Promise<GithubDirEntry[]>;
  /** Pull requests that contain this commit (usually the feature PR that landed it). */
  listPullRequestsForCommit(input: {
    owner: string;
    repo: string;
    sha: string;
  }): Promise<GithubAssociatedPullRequest[]>;
  /** Merge an open pull request (GitHub REST). Used by pre-prod sync. */
  mergePullRequest?(input: GithubPullRequestRef & { mergeMethod?: "merge" | "squash" }): Promise<{
    merged: boolean;
    sha?: string;
    raw: string;
  }>;
  /** Submitted reviews on a PR (GitHub REST). Used to detect pre-prod Approve / Request changes. */
  listPullRequestReviews?(input: GithubPullRequestRef): Promise<GithubPullRequestReview[]>;
}

export interface GithubPullRequestReview {
  userLogin: string;
  state: string;
  body?: string;
}
