import { netlifySitesForRepos } from "../netlify/repoProjects.js";
import { checkBranchDeploys } from "../netlify/watchDeploys.js";
import type { NetlifyProvider } from "../netlify/types.js";
import { PREPROD_TARGET_BRANCH } from "../preprod/constants.js";
import type { SlackIngestResult } from "../slack/ingestApprovals.js";
import type { Release } from "../types.js";

/**
 * One-shot Netlify check for a pre-prod release in PREPROD_DEPLOYING.
 * Does not call the engine — the watcher does.
 */
export async function resolvePreprodDeployEvent(options: {
  release: Release;
  netlify: NetlifyProvider;
  actor: string;
}): Promise<SlackIngestResult & { deployLines?: string[] }> {
  const { release, netlify, actor } = options;
  if (release.state !== "PREPROD_DEPLOYING") {
    return {
      status: "noop",
      reason: `Release is in ${release.state}, not PREPROD_DEPLOYING`,
      replies: [],
    };
  }

  const branch = release.repos[0]?.targetBranch || PREPROD_TARGET_BRANCH;
  const sites = netlifySitesForRepos(release.repos.map((repo) => repo.name));

  if (sites.length === 0) {
    return {
      status: "event",
      replies: [],
      deployLines: ["(no Netlify US/MX mapping for this repo)"],
      event: {
        type: "PREPROD_DEPLOY_SUCCEEDED",
        actor,
        payload: { verified: true, notes: "no Netlify mapping" },
      },
    };
  }

  const startedAt = release.deployment?.startedAt ?? release.updatedAt ?? new Date();
  const result = await checkBranchDeploys({ sites, branch, netlify, startedAt });
  if (result.ok) {
    const deployLines = result.deploys.map(
      (row) => `${row.region} ${row.site}: ${row.deploy.adminUrl ?? row.deploy.id}`
    );
    return {
      status: "event",
      replies: [],
      deployLines,
      event: {
        type: "PREPROD_DEPLOY_SUCCEEDED",
        actor,
        payload: {
          verified: true,
          deployIds: result.deploys.map((d) => d.deploy.id).join(","),
          notes: deployLines.join("\n"),
        },
      },
    };
  }
  if (result.pending) {
    return { status: "noop", reason: result.reason, replies: [] };
  }
  return {
    status: "event",
    replies: [],
    event: {
      type: "PREPROD_DEPLOY_FAILED",
      actor,
      payload: { notes: result.reason },
    },
  };
}
