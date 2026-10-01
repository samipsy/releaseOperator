import { GithubServiceError } from "../errors.js";
import { parseGithubBlobPackageJsonUrl } from "./catalogFromDir.js";
import { catalogGithubRepo, lookupCatalogRepo, readRepoCatalog, type CatalogRepo, type RepoCatalog } from "./repoCatalog.js";

export interface RequestedRepo {
  name: string;
  sourceBranch: string;
  owner?: string;
}

export interface ResolvedRepo extends RequestedRepo {
  owner: string;
  url: string;
  fullName: string;
}

export interface ParseReposResult {
  requested: RequestedRepo[];
}

const GITHUB_HTTPS = /^(https?:\/\/github\.com\/)([^/]+)\/([^/:]+?)(?:\.git)?(?::([^:]+))?$/i;
const GITHUB_SSH = /^git@github\.com:([^/]+)\/([^/:]+?)(?:\.git)?(?::([^:]+))?$/i;

/**
 * Parses --repos spec: name:branch, owner/name:branch, or a github.com URL optionally
 * followed by :branch. Colon in https:// is handled so URLs are not split on the scheme.
 */
export function parseReposSpec(spec: string): RequestedRepo[] {
  return spec.split(",").map((raw) => parseOneRepo(raw.trim())).filter((r) => r.name.length > 0);
}

function parseOneRepo(entry: string): RequestedRepo {
  if (!entry) throw new Error(`invalid --repos entry: "${entry}"`);

  const blob = parseGithubBlobPackageJsonUrl(entry);
  if (blob) {
    return { owner: blob.owner, name: blob.name, sourceBranch: blob.branch };
  }

  const https = entry.match(GITHUB_HTTPS);
  if (https) {
    return { owner: https[2], name: stripGitSuffix(https[3]), sourceBranch: https[4] || "main" };
  }
  const ssh = entry.match(GITHUB_SSH);
  if (ssh) {
    return { owner: ssh[1], name: stripGitSuffix(ssh[2]), sourceBranch: ssh[3] || "main" };
  }

  const [repoPart, sourceBranch = "main"] = entry.split(":").map((s) => s.trim());
  if (!repoPart) throw new Error(`invalid --repos entry: "${entry}"`);
  const slash = repoPart.lastIndexOf("/");
  if (slash === -1) return { name: repoPart, sourceBranch };
  return { owner: repoPart.slice(0, slash), name: repoPart.slice(slash + 1), sourceBranch };
}

/** True when the create repo argument encoded a branch (name:branch or a blob URL). */
export function repoArgHasExplicitBranch(repoArg: string): boolean {
  if (parseGithubBlobPackageJsonUrl(repoArg)) return true;
  if (/^https?:\/\//i.test(repoArg) || repoArg.startsWith("git@")) {
    return /(?:\.git)?:[A-Za-z0-9._/-]+$/.test(repoArg);
  }
  return repoArg.includes(":");
}

function stripGitSuffix(name: string): string {
  return name.endsWith(".git") ? name.slice(0, -4) : name;
}

export function loadRequiredCatalog(): RepoCatalog {
  const catalog = readRepoCatalog();
  if (!catalog || catalog.repos.length === 0) {
    throw new GithubServiceError(
      "No local GitHub repo catalog found. Run `github sync-repos` (org list) or " +
        "`github repos add --from-dir <clone>` for a test repo."
    );
  }
  return catalog;
}

export function resolveReposAgainstCatalog(requested: RequestedRepo[], catalog: RepoCatalog): ResolvedRepo[] {
  const unknown: string[] = [];
  const resolved: ResolvedRepo[] = [];

  for (const req of requested) {
    const nameMatches = catalog.repos.filter((r) => r.name.toLowerCase() === req.name.toLowerCase());
    if (!req.owner && nameMatches.length > 1) {
      const options = nameMatches.map((r) => r.fullName).join(", ");
      throw new GithubServiceError(
        `Repo name "${req.name}" is ambiguous in the catalog (${options}). Pass owner/name, e.g. ${nameMatches[0].fullName}:main.`
      );
    }
    const match = lookupCatalogRepo(catalog, req);
    if (!match) {
      unknown.push(req.owner ? `${req.owner}/${req.name}` : req.name);
      continue;
    }
    if (req.owner && req.owner.toLowerCase() !== match.owner.toLowerCase()) {
      unknown.push(`${req.owner}/${req.name}`);
      continue;
    }
    resolved.push({
      name: catalogGithubRepo(match),
      owner: match.owner,
      url: match.url,
      fullName: match.fullName,
      sourceBranch: req.sourceBranch,
    });
  }

  if (unknown.length > 0) {
    const sample = catalog.repos.slice(0, 8).map((r) => r.name).join(", ");
    throw new GithubServiceError(
      `Unknown GitHub repo(s): ${unknown.join(", ")}. Not in the local catalog for org ` +
        `"${catalog.org}" (synced ${catalog.syncedAt || "unknown"}). Known names include: ${sample}` +
        `${catalog.repos.length > 8 ? ", …" : ""}. Re-run \`github sync-repos\` if the repo is new, ` +
        "or `github repos add` to register a local test clone."
    );
  }
  return resolved;
}

export function catalogSummary(catalog: RepoCatalog): { org: string; count: number; syncedAt: string; names: string[] } {
  return {
    org: catalog.org,
    count: catalog.repos.length,
    syncedAt: catalog.syncedAt,
    names: catalog.repos.map((r: CatalogRepo) => r.name).sort((a, b) => a.localeCompare(b)),
  };
}
