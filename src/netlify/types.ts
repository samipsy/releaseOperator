export interface NetlifyDeploy {
  id: string;
  branch?: string;
  context?: string;
  state?: string;
  createdAt?: Date;
  /** Netlify UI URL for this deploy, used as the PCM rollback target. */
  adminUrl: string;
}

export interface NetlifyBuild {
  id: string;
  deployId?: string;
  sha?: string;
}

export interface NetlifyProvider {
  /** Latest ready production deploy from `main` (falls back to current published deploy). */
  latestMainDeploy(siteId: string): Promise<NetlifyDeploy | undefined>;
  /** Newest deploy for a branch (any context), e.g. pre-prod-1. */
  latestDeployForBranch(siteId: string, branch: string): Promise<NetlifyDeploy | undefined>;
  /**
   * Schedule a git build of the current HEAD of `branch` (not a retry of the last deploy SHA).
   * Netlify: POST /sites/{site_id}/builds?branch=
   */
  triggerBranchBuild(siteId: string, branch: string): Promise<NetlifyBuild>;
}
