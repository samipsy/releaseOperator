import type { Guard, GuardResult, Release, ReleaseEvent, ReleaseState, ReleaseEventType } from "./types.js";

function ok(): GuardResult {
  return { ok: true, reasons: [] };
}

function fail(...reasons: string[]): GuardResult {
  return { ok: false, reasons };
}

const hasRepos: Guard = (release) => {
  return release.repos.length > 0 ? ok() : fail("release has no repos declared");
};

const allBranchesCreated: Guard = (release) => {
  const missing = release.repos.filter((r) => !r.releaseBranch).map((r) => r.name);
  return missing.length === 0 ? ok() : fail(`missing release branch for repo(s): ${missing.join(", ")}`);
};

const qaApprovalHasApprover: Guard = (_release, event) => {
  const approvedBy = event.payload?.approvedBy;
  return typeof approvedBy === "string" && approvedBy.length > 0
    ? ok()
    : fail("QA_APPROVED requires payload.approvedBy");
};

const cabApprovalHasApprover: Guard = (_release, event) => {
  const approvedBy = event.payload?.approvedBy;
  return typeof approvedBy === "string" && approvedBy.length > 0
    ? ok()
    : fail("CAB_APPROVED requires payload.approvedBy");
};

/** The guard from the spec: everything must be true before READY_TO_DEPLOY. */
const readyToDeployChecks: Guard = (release) => {
  const reasons: string[] = [];

  const missingBranches = release.repos.filter((r) => !r.releaseBranch).map((r) => r.name);
  if (missingBranches.length > 0) {
    reasons.push(`missing release branch for repo(s): ${missingBranches.join(", ")}`);
  }
  const missingPrs = release.repos.filter((r) => !r.releasePrUrl).map((r) => r.name);
  if (missingPrs.length > 0) {
    reasons.push(`missing release PR for repo(s): ${missingPrs.join(", ")}`);
  }
  if (!release.ticket?.id) {
    reasons.push("change ticket does not exist");
  }
  if (release.approvals.qa?.status !== "approved") {
    reasons.push("QA approval is not in 'approved' status");
  }
  if (release.approvals.cab?.status !== "approved") {
    reasons.push("CAB approval is not in 'approved' status");
  }
  if (release.ci?.status !== "green") {
    reasons.push(`CI is not green (status: ${release.ci?.status ?? "unknown"})`);
  }
  const unknownFlags = release.featureFlags.filter((f) => !f.known).map((f) => f.key);
  if (unknownFlags.length > 0) {
    reasons.push(`feature flag state unknown for: ${unknownFlags.join(", ")}`);
  }

  return reasons.length === 0 ? ok() : fail(...reasons);
};

const sanityPassedBeforeFinalizing: Guard = (release) => {
  return release.sanity?.status === "passed" ? ok() : fail("sanity checks have not passed");
};

const ticketCreatedHasId: Guard = (release, event) => {
  const fromPayload = event.payload?.ticketId;
  const payloadId = typeof fromPayload === "string" ? fromPayload.trim() : "";
  const recordedId = release.ticket?.id?.trim() ?? "";
  return payloadId.length > 0 || recordedId.length > 0
    ? ok()
    : fail("TICKET_CREATED needs a ticket id from Jira create, or payload.ticketId");
};

const releasePrCoversAllRepos: Guard = (release, event) => {
  const prUrls = (event.payload?.prUrls as Record<string, string> | undefined) ?? {};
  const missing = release.repos.filter((r) => !(prUrls[r.name] || r.releasePrUrl)).map((r) => r.name);
  return missing.length === 0
    ? ok()
    : fail(`RELEASE_PR_CREATED is missing a pull request URL for repo(s): ${missing.join(", ")}`);
};

const backmergeHasPrUrl: Guard = (_release, event) => {
  const prUrl = event.payload?.prUrl;
  return typeof prUrl === "string" && prUrl.length > 0 ? ok() : fail("BACKMERGE_CREATED requires payload.prUrl");
};

const taggingCoversAllRepos: Guard = (release, event) => {
  const tags = (event.payload?.tags as Record<string, string> | undefined) ?? {};
  const missing = release.repos.filter((r) => !tags[r.name]).map((r) => r.name);
  return missing.length === 0 ? ok() : fail(`REPOS_TAGGED is missing a tag for repo(s): ${missing.join(", ")}`);
};

const isProdRelease: Guard = (release) => {
  return release.environment !== "preprod" ? ok() : fail("prod pipeline events cannot run on a preprod-sync release");
};

const isPreprodRelease: Guard = (release) => {
  return release.environment === "preprod" ? ok() : fail("preprod-sync events require environment preprod");
};

const preprodApprovalHasApprover: Guard = (_release, event) => {
  const approvedBy = event.payload?.approvedBy;
  return typeof approvedBy === "string" && approvedBy.length > 0
    ? ok()
    : fail("PREPROD_APPROVED requires payload.approvedBy");
};

const preprodMerged: Guard = (release) => {
  const sha = release.deployment?.deploymentId?.trim() ?? "";
  return sha.length > 0 ? ok() : fail("PREPROD_MERGED needs a merge SHA from GitHub");
};

const preprodDeploySucceeded: Guard = (release) => {
  return release.deployment?.status === "success"
    ? ok()
    : fail("Netlify pre-prod deploys have not completed successfully yet");
};

/** Guards keyed by "fromState:eventType". A transition with no entry here is unconditionally allowed. */
const GUARDS: Partial<Record<`${ReleaseState}:${ReleaseEventType}`, Guard[]>> = {
  "DRAFT:BRANCHES_CREATED": [hasRepos, isProdRelease],
  "DRAFT:PREPROD_PR_REQUESTED": [hasRepos, isPreprodRelease],
  "BRANCH_CREATED:RELEASE_PR_REQUESTED": [allBranchesCreated],
  "RELEASE_PR_PENDING:RELEASE_PR_CREATED": [releasePrCoversAllRepos],
  "TICKET_CREATE_PENDING:TICKET_CREATED": [ticketCreatedHasId],
  "QA_APPROVAL_PENDING:QA_APPROVED": [qaApprovalHasApprover],
  "CAB_APPROVAL_PENDING:CAB_APPROVED": [cabApprovalHasApprover],
  "CAB_APPROVED:READY_CHECK_PASSED": [readyToDeployChecks],
  "SANITY_PASSED:FINALIZE_REQUESTED": [sanityPassedBeforeFinalizing],
  "BACKMERGE_PENDING:BACKMERGE_CREATED": [backmergeHasPrUrl],
  "TAGGING_PENDING:REPOS_TAGGED": [taggingCoversAllRepos],
  "PREPROD_PR_PENDING:PREPROD_PR_CREATED": [releasePrCoversAllRepos],
  "PREPROD_APPROVAL_PENDING:PREPROD_APPROVED": [preprodApprovalHasApprover],
  "PREPROD_MERGING:PREPROD_MERGED": [preprodMerged],
  "PREPROD_DEPLOYING:PREPROD_DEPLOY_SUCCEEDED": [preprodDeploySucceeded],
};

export function runGuards(release: Release, event: ReleaseEvent): GuardResult {
  const key = `${release.state}:${event.type}` as `${ReleaseState}:${ReleaseEventType}`;
  const guards = GUARDS[key];
  if (!guards || guards.length === 0) return ok();

  const reasons = guards.flatMap((guard) => {
    const result = guard(release, event);
    return result.ok ? [] : result.reasons;
  });

  return reasons.length === 0 ? ok() : fail(...reasons);
}
