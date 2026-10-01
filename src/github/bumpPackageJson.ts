import { PACKAGE_JSON_CANDIDATES } from "./readPackageJson.js";
import type { GithubProvider } from "./types.js";
import { applyPackageJsonVersion } from "../versioning.js";

export interface PackageJsonBumpResult {
  path: string;
  previous?: string;
  skipped: boolean;
}

/**
 * Bump package.json version on a branch and commit it (GitHub Contents API pushes the commit).
 * Prefers app/package.json, then root package.json, unless packageJsonPath is set.
 */
export async function commitPackageJsonBump(options: {
  github: GithubProvider;
  owner: string;
  repo: string;
  branch: string;
  version: string;
  packageJsonPath?: string;
}): Promise<PackageJsonBumpResult | undefined> {
  const paths = options.packageJsonPath?.trim()
    ? [options.packageJsonPath.replace(/^\/+/, "")]
    : [...PACKAGE_JSON_CANDIDATES];

  for (const path of paths) {
    const file = await options.github.readFileMeta({
      owner: options.owner,
      repo: options.repo,
      path,
      ref: options.branch,
    });
    if (!file) continue;
    const bumped = applyPackageJsonVersion(file.text, options.version);
    if (!bumped.changed) {
      return { path, previous: bumped.previous, skipped: true };
    }
    await options.github.commitFile({
      owner: options.owner,
      repo: options.repo,
      path,
      branch: options.branch,
      sha: file.sha,
      content: bumped.text,
      message: `chore: bump version to ${options.version}`,
    });
    return { path, previous: bumped.previous, skipped: false };
  }
  return undefined;
}
