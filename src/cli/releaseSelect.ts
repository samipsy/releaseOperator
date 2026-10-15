import {
  isReleaseEventType,
  isReleaseState,
  type Release,
  type ReleaseEventType,
  type ReleaseState,
} from "../types.js";

/**
 * Operator-facing command names (imperative) mapped onto engine event types (facts).
 * Canonical names like BRANCHES_CREATED still work.
 */
export const EVENT_ALIASES: Record<string, ReleaseEventType> = {
  CREATE_BRANCH: "BRANCHES_CREATED",
  CREATE_BRANCHES: "BRANCHES_CREATED",
  BRANCH_CREATED: "BRANCHES_CREATED",
  CREATE_TICKET: "TICKET_CREATED",
  CREATE_PR: "RELEASE_PR_CREATED",
  OPEN_PR: "RELEASE_PR_CREATED",
  RETRY_PR: "RETRY_RELEASE_PR",
  RETRY_TICKET: "RETRY_TICKET_CREATE",
  APPROVE_QA: "QA_APPROVED",
  REJECT_QA: "QA_REJECTED",
  APPROVE_CAB: "CAB_APPROVED",
  REJECT_CAB: "CAB_REJECTED",
  REPORT_CI: "CI_STATUS_REPORTED",
  PASS_READY: "READY_CHECK_PASSED",
  READY: "READY_CHECK_PASSED",
  DEPLOY: "DEPLOY_REQUESTED",
  PASS_SANITY: "SANITY_PASSED",
  FAIL_SANITY: "SANITY_FAILED",
  UPDATE_TICKET: "TICKET_UPDATED",
  APPLY_CHANGE: "CHANGE_APPLIED",
  CREATE_BACKMERGE: "BACKMERGE_CREATED",
  TAG: "REPOS_TAGGED",
  TAG_REPOS: "REPOS_TAGGED",
  RETRY_TAG: "RETRY_TAGGING",
  ROLLBACK: "ROLLBACK_REQUESTED",
  CANCEL: "CANCELLED",
  BLOCK: "BLOCKED",
  UNBLOCK: "UNBLOCKED",
};

export function parseStatusFilter(raw: string): ReleaseState[] {
  const wanted = raw
    .split(",")
    .map((part) => part.trim().toUpperCase())
    .filter((part) => part.length > 0);
  if (wanted.length === 0) {
    throw new Error("Provide at least one status, e.g. CANCELLED.");
  }
  const unknown = wanted.filter((state) => !isReleaseState(state));
  if (unknown.length > 0) {
    throw new Error(`Unknown status: ${unknown.join(", ")}. Use a ReleaseState such as DRAFT, CANCELLED, COMPLETE.`);
  }
  return wanted as ReleaseState[];
}

export function latestNonCancelledRelease(
  releases: Release[],
  predicate?: (release: Release) => boolean
): Release | undefined {
  return releases.find((release) => release.state !== "CANCELLED" && (!predicate || predicate(release)));
}

export const PREPROD_EVENT_ALIASES: Record<string, ReleaseEventType> = {
  ...EVENT_ALIASES,
  START: "PREPROD_PR_REQUESTED",
  SYNC: "PREPROD_PR_REQUESTED",
  OPEN_PR: "PREPROD_PR_REQUESTED",
  CREATE_PR: "PREPROD_PR_REQUESTED",
  APPROVE: "PREPROD_APPROVED",
  APPROVE_PREPROD: "PREPROD_APPROVED",
  REJECT: "PREPROD_REJECTED",
  REJECT_PREPROD: "PREPROD_REJECTED",
  RETRY_MERGE: "RETRY_PREPROD_MERGE",
  RETRY_PREPROD_MERGE: "RETRY_PREPROD_MERGE",
};

export function resolveEventType(
  raw: string,
  aliases: Record<string, ReleaseEventType> = EVENT_ALIASES
): ReleaseEventType {
  const upper = raw.trim().toUpperCase().replace(/-/g, "_");
  const mapped = aliases[upper] ?? upper;
  if (!isReleaseEventType(mapped)) {
    throw new Error(
      `Unknown event "${raw}". Use an action like CREATE_BRANCH, CREATE_TICKET, APPROVE_QA, or a canonical event such as BRANCHES_CREATED.`
    );
  }
  return mapped;
}

export function resolveEventCommandArgs(
  a: string | undefined,
  b: string | undefined,
  aliases: Record<string, ReleaseEventType> = EVENT_ALIASES
): {
  releaseId?: string;
  eventType: ReleaseEventType;
} {
  if (!a) {
    throw new Error("Usage: event [releaseId] <eventType>  e.g. event CREATE_BRANCH");
  }
  if (!b) {
    return { eventType: resolveEventType(a, aliases) };
  }
  return { releaseId: a, eventType: resolveEventType(b, aliases) };
}

export function resolveReleaseIdForEvent(
  releases: Release[],
  explicitId?: string,
  predicate?: (release: Release) => boolean
): string {
  if (explicitId?.trim()) return explicitId.trim();
  const latest = latestNonCancelledRelease(releases, predicate);
  if (!latest) {
    throw new Error("No non-cancelled release found. Pass a release id.");
  }
  return latest.id;
}
