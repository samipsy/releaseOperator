import { parseGithubPullRequestUrl } from "./prUrl.js";
import { classifyPullRequestReviews } from "./prReviews.js";
import type { GithubProvider } from "./types.js";
import type { SlackIngestResult } from "../slack/ingestApprovals.js";
import type { Release } from "../types.js";

/**
 * Reads GitHub PR reviews for a pre-prod sync release. Does not call the engine — the watcher does.
 */
export async function resolveGithubPrApprovalEvent(options: {
  release: Release;
  github: GithubProvider;
  actor: string;
}): Promise<SlackIngestResult> {
  const { release, github, actor } = options;
  if (release.state !== "PREPROD_APPROVAL_PENDING") {
    return {
      status: "noop",
      reason: `Release is in ${release.state}, not PREPROD_APPROVAL_PENDING`,
      replies: [],
    };
  }
  const listReviews = github.listPullRequestReviews?.bind(github);
  if (!listReviews) {
    return {
      status: "noop",
      reason: "GitHub PR review listing is not configured",
      replies: [],
    };
  }

  const refs = release.repos
    .map((repo) => (repo.releasePrUrl ? parseGithubPullRequestUrl(repo.releasePrUrl) : undefined))
    .filter((ref): ref is NonNullable<typeof ref> => Boolean(ref));
  if (refs.length === 0) {
    return {
      status: "noop",
      reason: "No GitHub PR URL stored on this release — was the pre-prod PR created?",
      replies: [],
    };
  }

  let approvedBy: string | undefined;
  for (const ref of refs) {
    const reviews = await listReviews({
      owner: ref.owner,
      repo: ref.repo,
      pullNumber: ref.number,
    });
    const verdict = classifyPullRequestReviews(reviews);
    if (verdict.kind === "reject") {
      return {
        status: "event",
        replies: [],
        event: {
          type: "PREPROD_REJECTED",
          actor,
          payload: { rejectedBy: verdict.userLogin, notes: "GitHub requested changes" },
        },
      };
    }
    if (verdict.kind === "approve") {
      approvedBy = verdict.userLogin;
      continue;
    }
    // Manual merge without an Approve review — still advance so merge action can pick up the SHA.
    const snapshot = await github.getPullRequest({
      owner: ref.owner,
      repo: ref.repo,
      pullNumber: ref.number,
    });
    if (snapshot.merged) {
      approvedBy = approvedBy ?? actor;
      continue;
    }
    return {
      status: "noop",
      reason: `No GitHub Approve yet on ${ref.owner}/${ref.repo}#${ref.number} (Review changes → Approve)`,
      replies: [],
    };
  }

  return {
    status: "event",
    replies: [],
    event: {
      type: "PREPROD_APPROVED",
      actor,
      payload: { approvedBy: approvedBy ?? actor },
    },
  };
}
