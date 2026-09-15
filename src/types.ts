export type ReleaseState =
  | "DRAFT"
  | "BRANCH_CREATED"
  | "CHANGE_TICKET_CREATED"
  | "QA_APPROVAL_PENDING"
  | "QA_APPROVED"
  | "CAB_APPROVAL_PENDING"
  | "CAB_APPROVED"
  | "READY_TO_DEPLOY"
  | "DEPLOYING"
  | "DEPLOYED"
  | "SANITY_CHECKING"
  | "SANITY_PASSED"
  | "FINALIZING"
  | "TICKET_UPDATE_FAILED"
  | "TICKET_UPDATED"
  | "BACKMERGE_PENDING"
  | "BACKMERGE_FAILED"
  | "BACKMERGE_CREATED"
  | "TAGGING_PENDING"
  | "TAGGING_FAILED"
  | "TAGGED"
  | "COMPLETE"
  | "BLOCKED"
  | "FAILED"
  | "ROLLED_BACK"
  | "CANCELLED";

export type ReleaseEventType =
  | "RELEASE_CREATED"
  | "BRANCHES_CREATED"
  | "TICKET_CREATED"
  | "QA_APPROVAL_REQUESTED"
  | "QA_APPROVED"
  | "QA_REJECTED"
  | "CAB_APPROVAL_REQUESTED"
  | "CAB_APPROVED"
  | "CAB_REJECTED"
  | "READY_CHECK_PASSED"
  | "DEPLOY_REQUESTED"
  | "DEPLOY_SUCCEEDED"
  | "DEPLOY_FAILED"
  | "SANITY_STARTED"
  | "SANITY_PASSED"
  | "SANITY_FAILED"
  | "FINALIZE_REQUESTED"
  | "RELEASE_FINALIZED"
  | "TICKET_UPDATED"
  | "TICKET_UPDATE_FAILED"
  | "RETRY_TICKET_UPDATE"
  | "BACKMERGE_REQUESTED"
  | "BACKMERGE_CREATED"
  | "BACKMERGE_FAILED"
  | "RETRY_BACKMERGE"
  | "TAGGING_REQUESTED"
  | "REPOS_TAGGED"
  | "TAGGING_FAILED"
  | "RETRY_TAGGING"
  | "CI_STATUS_REPORTED"
  | "ROLLBACK_REQUESTED"
  | "ROLLBACK_COMPLETED"
  | "BLOCKED"
  | "UNBLOCKED"
  | "CANCELLED";

export interface Approval {
  status: "pending" | "approved" | "rejected";
  approvedBy?: string;
  approvedAt?: Date;
  notes?: string;
}

export interface ReleaseRepo {
  name: string;
  /** GitHub owner/org for this repo. Falls back to RELEASE_OPERATOR_GITHUB_ORG if unset. */
  owner?: string;
  sourceBranch: string;
  releaseBranch?: string;
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
