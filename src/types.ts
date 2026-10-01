export const RELEASE_STATES = [
  "DRAFT",
  "BRANCH_CREATED",
  "RELEASE_PR_PENDING",
  "RELEASE_PR_FAILED",
  "RELEASE_PR_OPEN",
  "TICKET_CREATE_PENDING",
  "TICKET_CREATE_FAILED",
  "CHANGE_TICKET_CREATED",
  "QA_APPROVAL_PENDING",
  "QA_APPROVED",
  "CAB_APPROVAL_PENDING",
  "CAB_APPROVED",
  "READY_TO_DEPLOY",
  "DEPLOYING",
  "DEPLOYED",
  "SANITY_CHECKING",
  "SANITY_PASSED",
  "FINALIZING",
  "TICKET_UPDATE_FAILED",
  "TICKET_UPDATED",
  "CHANGE_APPLIED",
  "BACKMERGE_PENDING",
  "BACKMERGE_FAILED",
  "BACKMERGE_CREATED",
  "TAGGING_PENDING",
  "TAGGING_FAILED",
  "TAGGED",
  "COMPLETE",
  "BLOCKED",
  "FAILED",
  "ROLLED_BACK",
  "CANCELLED",
  "PREPROD_PR_PENDING",
  "PREPROD_PR_FAILED",
  "PREPROD_PR_OPEN",
  "PREPROD_APPROVAL_PENDING",
  "PREPROD_APPROVED",
  "PREPROD_MERGING",
  "PREPROD_MERGE_FAILED",
  "PREPROD_MERGED",
  "PREPROD_DEPLOYING",
  "PREPROD_DEPLOY_FAILED",
] as const;

export type ReleaseState = (typeof RELEASE_STATES)[number];

const RELEASE_STATE_SET: ReadonlySet<string> = new Set(RELEASE_STATES);

export function isReleaseState(value: string): value is ReleaseState {
  return RELEASE_STATE_SET.has(value);
}

export const RELEASE_EVENT_TYPES = [
  "RELEASE_CREATED",
  "BRANCHES_CREATED",
  "RELEASE_PR_REQUESTED",
  "RELEASE_PR_CREATED",
  "RELEASE_PR_FAILED",
  "RETRY_RELEASE_PR",
  "TICKET_CREATE_REQUESTED",
  "TICKET_CREATED",
  "TICKET_CREATE_FAILED",
  "RETRY_TICKET_CREATE",
  "QA_APPROVAL_REQUESTED",
  "QA_APPROVED",
  "QA_REJECTED",
  "CAB_APPROVAL_REQUESTED",
  "CAB_APPROVED",
  "CAB_REJECTED",
  "READY_CHECK_PASSED",
  "DEPLOY_REQUESTED",
  "DEPLOY_SUCCEEDED",
  "DEPLOY_FAILED",
  "SANITY_STARTED",
  "SANITY_PASSED",
  "SANITY_FAILED",
  "FINALIZE_REQUESTED",
  "RELEASE_FINALIZED",
  "TICKET_UPDATED",
  "TICKET_UPDATE_FAILED",
  "RETRY_TICKET_UPDATE",
  "CHANGE_APPLIED",
  "BACKMERGE_REQUESTED",
  "BACKMERGE_CREATED",
  "BACKMERGE_FAILED",
  "RETRY_BACKMERGE",
  "TAGGING_REQUESTED",
  "REPOS_TAGGED",
  "TAGGING_FAILED",
  "RETRY_TAGGING",
  "CI_STATUS_REPORTED",
  "ROLLBACK_REQUESTED",
  "ROLLBACK_COMPLETED",
  "BLOCKED",
  "UNBLOCKED",
  "CANCELLED",
  "PREPROD_PR_REQUESTED",
  "PREPROD_PR_CREATED",
  "PREPROD_PR_FAILED",
  "RETRY_PREPROD_PR",
  "PREPROD_APPROVAL_REQUESTED",
  "PREPROD_APPROVED",
  "PREPROD_REJECTED",
  "PREPROD_MERGE_REQUESTED",
  "PREPROD_MERGED",
  "PREPROD_MERGE_FAILED",
  "RETRY_PREPROD_MERGE",
  "PREPROD_DEPLOY_WATCH",
  "PREPROD_DEPLOY_SUCCEEDED",
  "PREPROD_DEPLOY_FAILED",
  "RETRY_PREPROD_DEPLOY",
] as const;

export type ReleaseEventType = (typeof RELEASE_EVENT_TYPES)[number];

const RELEASE_EVENT_SET: ReadonlySet<string> = new Set(RELEASE_EVENT_TYPES);

export function isReleaseEventType(value: string): value is ReleaseEventType {
  return RELEASE_EVENT_SET.has(value);
}

export interface Approval {
  status: "pending" | "approved" | "rejected";
  approvedBy?: string;
  approvedAt?: Date;
  notes?: string;
  /** Slack channel id or name where the approval request was posted. */
  slackChannel?: string;
  /** Parent message timestamp for the approval thread. */
  slackTs?: string;
}

export interface ReleaseRepo {
  name: string;
  /** GitHub owner/org for this repo. Falls back to RELEASE_OPERATOR_GITHUB_ORG if unset. */
  owner?: string;
  /** Canonical GitHub HTML URL, filled from the local org catalog on `create`. */
  url?: string;
  sourceBranch: string;
  /**
   * Branch the release PR merges into (usually main). Independent of sourceBranch,
   * which is where the release branch is cut from (sometimes develop).
   */
  targetBranch?: string;
  releaseBranch?: string;
  /** PR opened to merge the release branch into targetBranch. */
  releasePrUrl?: string;
  /** Path used to bump version on the release branch (app/package.json or package.json). */
  packageJsonPath?: string;
  deployedCommit?: string;
  tag?: string;
}

export interface FeatureFlag {
  key: string;
  known: boolean;
  notes?: string;
}

export interface Release {
  id: string;
  version: string;
  /** Semver bump used at create (major / minor / patch). */
  bump?: "major" | "minor" | "patch";
  /** Operator-provided change window; Jira Planned start / Due date. */
  plannedStart?: string;
  /** Operator-provided change window; Jira Planned end. */
  plannedEnd?: string;
  /** JSM Affected services: ARI ids or search names collected at create. */
  affectedServices?: string[];

  state: ReleaseState;
  /** State this release was in before entering BLOCKED, so UNBLOCKED can resume it. */
  preBlockState?: ReleaseState;

  repos: ReleaseRepo[];

  environment: "prod" | "preprod";

  ticket?: {
    id: string;
    url?: string;
    updatedAt?: Date;
    updateNotes?: string;
  };

  approvals: {
    qa?: Approval;
    cab?: Approval;
    preprod?: Approval;
  };

  ci?: {
    status: "unknown" | "pending" | "green" | "red";
  };

  featureFlags: FeatureFlag[];

  deployment?: {
    status: "pending" | "running" | "success" | "failed";
    deploymentId?: string;
    startedAt?: Date;
    completedAt?: Date;
  };

  sanity?: {
    status: "pending" | "running" | "passed" | "failed";
    results?: Record<string, unknown>;
  };

  rollback?: {
    reason?: string;
    requestedAt?: Date;
    completedAt?: Date;
  };

  releasePr?: {
    status: "pending" | "success" | "failed";
    attempts?: number;
  };

  backmerge?: {
    status: "pending" | "success" | "failed";
    prUrl?: string;
    attempts?: number;
  };

  tagging?: {
    status: "pending" | "success" | "failed";
    attempts?: number;
  };

  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReleaseEvent<P = Record<string, unknown>> {
  type: ReleaseEventType;
  payload?: P;
  actor: string;
}

export type EventOutcome = "APPLIED" | "REJECTED";

export interface EventLogEntry {
  seq: number;
  releaseId: string;
  type: ReleaseEventType;
  payload: Record<string, unknown> | undefined;
  actor: string;
  fromState: ReleaseState;
  toState: ReleaseState | null;
  outcome: EventOutcome;
  reason?: string;
  createdAt: Date;
}

export interface GuardResult {
  ok: boolean;
  reasons: string[];
}

export type Guard = (release: Release, event: ReleaseEvent) => GuardResult;

export type Action = (release: Release, event: ReleaseEvent, previousState: ReleaseState) => void | Promise<void>;
