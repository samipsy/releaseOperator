import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CatalogRepo } from "./repoCatalog.js";

const GITHUB_HTTPS = /^https?:\/\/github\.com\/([^/]+)\/([^/:]+?)(?:\.git)?\/?$/i;
const GITHUB_SSH = /^git@github\.com:([^/]+)\/([^/:]+?)(?:\.git)?$/i;

export function looksLikeFilesystemPath(value: string): boolean {
  if (value.startsWith("file:")) return true;
  if (/^(https?:\/\/|git@)/i.test(value)) return false;
  return value.startsWith("/") || value.startsWith(".") || existsSync(value);
}

export function parseGithubRemote(url: string): { owner: string; name: string; url: string } | undefined {
  const https = url.trim().match(GITHUB_HTTPS);
  if (https) {
    return { owner: https[1], name: stripGitSuffix(https[2]), url: `https://github.com/${https[1]}/${stripGitSuffix(https[2])}` };
  }
  const ssh = url.trim().match(GITHUB_SSH);
  if (ssh) {
    return { owner: ssh[1], name: stripGitSuffix(ssh[2]), url: `https://github.com/${ssh[1]}/${stripGitSuffix(ssh[2])}` };
  }
  return undefined;
}

function stripGitSuffix(name: string): string {
  return name.endsWith(".git") ? name.slice(0, -4) : name;
}

const PACKAGE_JSON_SUFFIXES = ["app/package.json", "package.json"] as const;

/**
 * Parses a GitHub blob URL such as
 * https://github.com/myglam/experience/blob/main/app/package.json
 */
export function parseGithubBlobPackageJsonUrl(
  url: string
): { owner: string; name: string; branch: string; packageJsonPath: string; url: string } | undefined {
  const match = url.trim().match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i);
  if (!match) return undefined;
  const rest = match[3];
  for (const suffix of PACKAGE_JSON_SUFFIXES) {
    if (rest === suffix || rest.endsWith(`/${suffix}`)) {
      const branch = rest === suffix ? "" : rest.slice(0, -(suffix.length + 1));
      if (!branch) continue;
      const owner = match[1];
      const name = stripGitSuffix(match[2]);
      return {
        owner,
        name,
        branch,
        packageJsonPath: suffix,
        url: `https://github.com/${owner}/${name}`,
      };
    }
  }
  return undefined;
}

function gitRemoteOrigin(dir: string): string | undefined {
  const result = spawnSync("git", ["-C", dir, "remote", "get-url", "origin"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.status !== 0) return undefined;
  const url = result.stdout.trim();
  return url.length > 0 ? url : undefined;
}

/**
 * Builds a manual catalog row from a local clone (or any directory).
 * Prefers `origin` when it is a GitHub remote; otherwise stores a file:// URL.
 */
export function catalogRepoFromWorkspaceDir(
  dir: string,
  overrides?: { name?: string; owner?: string; url?: string; defaultBranch?: string; packageJsonPath?: string }
): CatalogRepo {
  const localPath = resolve(dir);
  if (!existsSync(localPath) || !statSync(localPath).isDirectory()) {
    throw new Error(`Not a directory: ${dir}`);
  }

  const origin = gitRemoteOrigin(localPath);
  const blob = overrides?.url ? parseGithubBlobPackageJsonUrl(overrides.url) : undefined;
  const parsed = blob ?? (origin ? parseGithubRemote(origin) : undefined);
  const name = overrides?.name ?? parsed?.name ?? basename(localPath);
  const githubName = parsed?.name ?? (overrides?.name ? undefined : basename(localPath));
  const owner = overrides?.owner ?? parsed?.owner ?? process.env.RELEASE_OPERATOR_GITHUB_ORG ?? "local";
  const url =
    blob?.url ??
    (overrides?.url && !looksLikeFilesystemPath(overrides.url) && !blob ? overrides.url : undefined) ??
    parsed?.url ??
    (origin && !looksLikeFilesystemPath(origin) ? origin : pathToFileURL(localPath).href);
  const defaultBranch = overrides?.defaultBranch ?? blob?.branch;
  const packageJsonPath = overrides?.packageJsonPath ?? blob?.packageJsonPath;
  const githubRepo =
    githubName && githubName.toLowerCase() !== name.toLowerCase() ? githubName : undefined;

  return {
    name,
    owner,
    fullName: `${owner}/${githubName ?? name}`,
    url,
    source: "manual",
    localPath,
    ...(defaultBranch ? { defaultBranch } : {}),
    ...(packageJsonPath ? { packageJsonPath } : {}),
    ...(githubRepo ? { githubRepo } : {}),
  };
}

export function catalogRepoFromUrl(opts: {
  url: string;
  name?: string;
  owner?: string;
  defaultBranch?: string;
  packageJsonPath?: string;
}): CatalogRepo {
  if (looksLikeFilesystemPath(opts.url)) {
    const dir = opts.url.startsWith("file:") ? fileURLToPath(opts.url) : opts.url;
    return catalogRepoFromWorkspaceDir(dir, {
      name: opts.name,
      owner: opts.owner,
      defaultBranch: opts.defaultBranch,
      packageJsonPath: opts.packageJsonPath,
    });
  }
  const blob = parseGithubBlobPackageJsonUrl(opts.url);
  const parsed = blob ?? parseGithubRemote(opts.url);
  const githubName = parsed?.name;
  const name = opts.name ?? githubName;
  if (!name) {
    throw new Error("Pass --name; could not infer the repo name from --url.");
  }
  const owner = opts.owner ?? parsed?.owner ?? process.env.RELEASE_OPERATOR_GITHUB_ORG ?? "local";
  const defaultBranch = opts.defaultBranch ?? blob?.branch;
  const packageJsonPath = opts.packageJsonPath ?? blob?.packageJsonPath;
  const githubRepo =
    githubName && githubName.toLowerCase() !== name.toLowerCase() ? githubName : undefined;
  return {
    name,
    owner,
    fullName: `${owner}/${githubName ?? name}`,
    url: blob?.url ?? parsed?.url ?? opts.url,
    source: "manual",
    ...(defaultBranch ? { defaultBranch } : {}),
    ...(packageJsonPath ? { packageJsonPath } : {}),
    ...(githubRepo ? { githubRepo } : {}),
  };
}
