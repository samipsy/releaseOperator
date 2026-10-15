export const PREPROD_SOURCE_BRANCH = "develop";
export const PREPROD_TARGET_BRANCH = "pre-prod-1";
/** Conventional-commit / ticket prefix for pre-prod sync PRs. */
export const PREPROD_PR_TICKET = "MET-1111";
export const DEFAULT_PREPROD_WORKFLOW_PATH = "./config/preprod-sync.yaml";

export function preprodSyncPrTitle(
  source: string = PREPROD_SOURCE_BRANCH,
  target: string = PREPROD_TARGET_BRANCH
): string {
  return `chore(${PREPROD_PR_TICKET}): Sync ${source} -> ${target}`;
}
