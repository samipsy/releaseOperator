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

const backmergeHasPrUrl: Guard = (_release, event) => {
  const prUrl = event.payload?.prUrl;
  return typeof prUrl === "string" && prUrl.length > 0 ? ok() : fail("BACKMERGE_CREATED requires payload.prUrl");
};

const taggingCoversAllRepos: Guard = (release, event) => {
  const tags = (event.payload?.tags as Record<string, string> | undefined) ?? {};
  const missing = release.repos.filter((r) => !tags[r.name]).map((r) => r.name);
  return missing.length === 0 ? ok() : fail(`REPOS_TAGGED is missing a tag for repo(s): ${missing.join(", ")}`);
};

/** Guards keyed by "fromState:eventType". A transition with no entry here is unconditionally allowed. */
const GUARDS: Partial<Record<`${ReleaseState}:${ReleaseEventType}`, Guard[]>> = {
  "DRAFT:BRANCHES_CREATED": [hasRepos],
  "BRANCH_CREATED:TICKET_CREATED": [allBranchesCreated],
  "QA_APPROVAL_PENDING:QA_APPROVED": [qaApprovalHasApprover],
  "CAB_APPROVAL_PENDING:CAB_APPROVED": [cabApprovalHasApprover],
  "CAB_APPROVED:READY_CHECK_PASSED": [readyToDeployChecks],
  "SANITY_PASSED:FINALIZE_REQUESTED": [sanityPassedBeforeFinalizing],
  "BACKMERGE_PENDING:BACKMERGE_CREATED": [backmergeHasPrUrl],
  "TAGGING_PENDING:REPOS_TAGGED": [taggingCoversAllRepos],
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
