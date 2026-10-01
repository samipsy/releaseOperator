import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { GithubServiceError } from "../errors.js";

export const DEFAULT_REPO_CATALOG_PATH = "./.github-repos.json";

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export type CatalogRepoSource = "sync" | "manual";

export interface CatalogRepo {
  name: string;
  owner: string;
  fullName: string;
  url: string;
  /** `manual` entries (test clones / overrides) are kept across `github sync-repos`. */
  source?: CatalogRepoSource;
  /** Absolute path to a local clone, when registered with `--from-dir` or a filesystem `--url`. */
  localPath?: string;
  /** GitHub default branch (from org sync), used when create is not given --branch. */
  defaultBranch?: string;
  /** Path to package.json in the repo, e.g. app/package.json. */
  packageJsonPath?: string;
  /**
   * GitHub repo slug when `name` is a catalog alias (`--name`).
   * GitHub API calls use this (or `fullName`), not the alias.
   */
  githubRepo?: string;
}

export interface RepoCatalog {
  org: string;
  syncedAt: string;
  repos: CatalogRepo[];
}

export function repoCatalogPath(): string {
  return resolve(process.env.RELEASE_OPERATOR_GITHUB_REPO_CATALOG ?? DEFAULT_REPO_CATALOG_PATH);
}

export function readRepoCatalog(path: string = repoCatalogPath()): RepoCatalog | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (typeof parsed.org !== "string" || !Array.isArray(parsed.repos)) {
      throw new Error("missing org or repos");
    }
    const repos: CatalogRepo[] = [];
    for (const item of parsed.repos) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      if (
        typeof rec.name !== "string" ||
        typeof rec.owner !== "string" ||
        typeof rec.fullName !== "string" ||
        typeof rec.url !== "string"
      ) {
        continue;
      }
      const source: CatalogRepoSource | undefined =
        rec.source === "manual" || rec.source === "sync" ? rec.source : undefined;
      const localPath = optionalString(rec.localPath);
      const defaultBranch = optionalString(rec.defaultBranch);
      const packageJsonPath = optionalString(rec.packageJsonPath);
      const githubRepo = optionalString(rec.githubRepo);
      repos.push({
        name: rec.name,
        owner: rec.owner,
        fullName: rec.fullName,
        url: rec.url,
        ...(source ? { source } : {}),
        ...(localPath ? { localPath } : {}),
        ...(defaultBranch ? { defaultBranch } : {}),
        ...(packageJsonPath ? { packageJsonPath } : {}),
        ...(githubRepo ? { githubRepo } : {}),
      });
    }
    return {
      org: parsed.org,
      syncedAt: typeof parsed.syncedAt === "string" ? parsed.syncedAt : "",
      repos,
    };
  } catch (err) {
    throw new GithubServiceError(`Could not read GitHub repo catalog at ${path}: ${(err as Error).message}`, err);
  }
}

export function writeRepoCatalog(catalog: RepoCatalog, path: string = repoCatalogPath()): void {
  const dest = path;
  const dir = dirname(dest);
  if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
  writeFileSync(dest, `${JSON.stringify(catalog, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(dest, 0o600);
  } catch {
    // best-effort
  }
}

export function lookupCatalogRepo(
  catalog: RepoCatalog,
  input: { name: string; owner?: string }
): CatalogRepo | undefined {
  const name = input.name.toLowerCase();
  const owner = input.owner?.toLowerCase();
  const matches = catalog.repos.filter((r) => r.name.toLowerCase() === name);
  if (owner) {
    return matches.find((r) => r.owner.toLowerCase() === owner) ??
      catalog.repos.find((r) => r.fullName.toLowerCase() === `${owner}/${name}`);
  }
  if (matches.length === 1) return matches[0];
  return undefined;
}

/** GitHub repo slug for API calls (`githubRepo` when `name` is a catalog alias). */
export function catalogGithubRepo(repo: CatalogRepo): string {
  if (repo.githubRepo) return repo.githubRepo;
  const slash = repo.fullName.lastIndexOf("/");
  if (slash !== -1 && slash < repo.fullName.length - 1) return repo.fullName.slice(slash + 1);
  return repo.name;
}

export function mergeSyncedCatalog(org: string, synced: CatalogRepo[], existing?: RepoCatalog): RepoCatalog {
  const previous = new Map((existing?.repos ?? []).map((r) => [r.name.toLowerCase(), r]));
  const byName = new Map<string, CatalogRepo>();
  for (const repo of synced) {
    const prev = previous.get(repo.name.toLowerCase());
    byName.set(repo.name.toLowerCase(), {
      ...repo,
      source: repo.source ?? "sync",
      packageJsonPath: repo.packageJsonPath ?? prev?.packageJsonPath,
      defaultBranch: repo.defaultBranch ?? prev?.defaultBranch,
    });
  }
  const manuals = existing?.repos.filter((r) => r.source === "manual") ?? [];
  for (const repo of manuals) {
    byName.set(repo.name.toLowerCase(), { ...repo, source: "manual" });
  }
  const repos = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    org,
    syncedAt: new Date().toISOString(),
    repos,
  };
}

export function upsertManualCatalogRepo(
  repo: CatalogRepo,
  path?: string,
  options?: { replace?: boolean }
): RepoCatalog {
  const dest = path ?? repoCatalogPath();
  const existing = readRepoCatalog(dest);
  const org = existing?.org ?? process.env.RELEASE_OPERATOR_GITHUB_ORG ?? "local";
  const entry: CatalogRepo = { ...repo, source: "manual" };
  const clash = (existing?.repos ?? []).find((r) => r.name.toLowerCase() === entry.name.toLowerCase());
  if (clash && !options?.replace) {
    throw new GithubServiceError(
      `Catalog already has "${clash.name}" (${clash.fullName}). ` +
        `Pass --name <unique-alias> to add another row for the same GitHub repo, or --replace to overwrite.`
    );
  }
  const others = (existing?.repos ?? []).filter((r) => r.name.toLowerCase() !== entry.name.toLowerCase());
  const catalog: RepoCatalog = {
    org,
    syncedAt: existing?.syncedAt ?? "",
    repos: [...others, entry].sort((a, b) => a.name.localeCompare(b.name)),
  };
  writeRepoCatalog(catalog, dest);
  return catalog;
}

export function removeCatalogRepo(name: string, path: string = repoCatalogPath()): RepoCatalog {
  const existing = readRepoCatalog(path);
  if (!existing) {
    throw new GithubServiceError("No catalog yet. Run `github sync-repos` or `github repos add` first.");
  }
  const key = name.toLowerCase();
  const repos = existing.repos.filter((r) => r.name.toLowerCase() !== key && r.fullName.toLowerCase() !== key);
  if (repos.length === existing.repos.length) {
    throw new GithubServiceError(`No catalog entry named "${name}".`);
  }
  const catalog: RepoCatalog = { ...existing, repos };
  writeRepoCatalog(catalog, path);
  return catalog;
}
