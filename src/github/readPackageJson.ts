import { GithubServiceError } from "../errors.js";
import { catalogGithubRepo, type CatalogRepo } from "./repoCatalog.js";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";

/** Tried in order when the catalog does not set packageJsonPath. */
export const PACKAGE_JSON_CANDIDATES = ["app/package.json", "package.json"] as const;

export interface PackageJsonReadResult {
  version: string;
  ref: string;
  path: string;
}

function normalizeRepoPath(path: string): string {
  return path.replace(/^\/+/, "").trim();
}

export function packageJsonPathsForRepo(repo: CatalogRepo): string[] {
  if (repo.packageJsonPath) return [normalizeRepoPath(repo.packageJsonPath)];
  return [...PACKAGE_JSON_CANDIDATES];
}

function versionFromPackageJsonText(text: string, label: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new GithubServiceError(`Could not parse ${label} as JSON: ${(err as Error).message}`, err);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new GithubServiceError(`${label} is not a JSON object.`);
  }
  const version = (parsed as Record<string, unknown>).version;
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new GithubServiceError(`${label} has no string "version" field.`);
  }
  return version.trim();
}

async function readGithubFile(options: {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  token: string;
  fetchImpl: typeof fetch;
}): Promise<{ ok: true; text: string } | { ok: false; status: number; statusText: string }> {
  const url = `${GITHUB_API_BASE}/repos/${options.owner}/${options.repo}/contents/${options.path}?ref=${encodeURIComponent(options.branch)}`;
  const response = await options.fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${options.token}`,
      Accept: "application/vnd.github.raw+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
  });
  if (!response.ok) {
    return { ok: false, status: response.status, statusText: response.statusText };
  }
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.content === "string" && parsed.encoding === "base64") {
      return { ok: true, text: Buffer.from(parsed.content, "base64").toString("utf8") };
    }
  } catch {
    // GitHub returned raw file text
  }
  return { ok: true, text };
}

/**
 * Reads package.json version from GitHub Contents REST for a catalog repo.
 * Never reads the local filesystem. Tries app/package.json then package.json unless
 * the catalog sets packageJsonPath. The engine does not call this.
 */
export async function readRepoPackageJsonVersion(options: {
  repo: CatalogRepo;
  branch: string;
  token?: string;
  fetchImpl?: typeof fetch;
}): Promise<PackageJsonReadResult> {
  const token = options.token ?? process.env.RELEASE_OPERATOR_GITHUB_TOKEN;
  if (!token) {
    throw new GithubServiceError(
      "RELEASE_OPERATOR_GITHUB_TOKEN is unset — cannot read package.json from GitHub."
    );
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const paths = packageJsonPathsForRepo(options.repo);
  const tried: string[] = [];

  for (const path of paths) {
    const result = await readGithubFile({
      owner: options.repo.owner,
      repo: catalogGithubRepo(options.repo),
      branch: options.branch,
      path,
      token,
      fetchImpl,
    });
    const ref = `${options.repo.fullName}@${options.branch}:${path}`;
    if (result.ok) {
      return { version: versionFromPackageJsonText(result.text, ref), ref, path };
    }
    tried.push(`${path} (${result.status})`);
    if (result.status !== 404) {
      throw new GithubServiceError(
        `Could not read ${ref}: HTTP ${result.status} ${result.statusText}`
      );
    }
  }

  throw new GithubServiceError(
    `Could not find package.json on ${options.repo.fullName}@${options.branch} (tried ${tried.join(", ")}).`
  );
}
