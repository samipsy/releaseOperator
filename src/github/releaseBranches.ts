/** Default branch to cut the release from (`create --source`). */
export const DEFAULT_RELEASE_SOURCE_BRANCH = "develop";

/** Default branch the release PR merges into (`create --target`). */
export const DEFAULT_RELEASE_MERGE_BASE = "main";

/**
 * Branch the release PR merges into, and the base for "commits in this release".
 * Uses `targetBranch` when set; otherwise `main`.
 */
export function releasePrBase(repo: { sourceBranch: string; targetBranch?: string }): string {
  const target = repo.targetBranch?.trim();
  if (target) return target;
  return DEFAULT_RELEASE_MERGE_BASE;
}

/** Head of the post-release backmerge PR: the branch that received the release (target). */
export function backmergePrHead(repo: { sourceBranch: string; targetBranch?: string }): string {
  return releasePrBase(repo);
}

/** Base of the post-release backmerge PR: the original cut branch (source). */
export function backmergePrBase(repo: { sourceBranch: string }): string {
  return repo.sourceBranch;
}
