import { randomUUID } from "node:crypto";
import type { Release, ReleaseEvent, ReleaseRepo, ReleaseState } from "./types.js";
import { ReleaseStore } from "./store.js";
import { legalTarget, RESUME_PREVIOUS } from "./transitions.js";
import { runGuards } from "./guards.js";
import { buildOnEnterRegistry, runActions, type ActionDeps } from "./actions.js";
import { GuardFailedError, IllegalTransitionError } from "./errors.js";

const TERMINAL_STATES: ReadonlySet<ReleaseState> = new Set(["COMPLETE", "ROLLED_BACK", "CANCELLED"]);

/**
 * Events that update release fields without ever moving ReleaseState — e.g. CI status can
 * change at any point while a release is in flight. These skip TRANSITIONS/GUARDS/actions
 * entirely rather than requiring a repetitive self-loop entry in every non-terminal state.
 */
export const SIDECAR_EVENTS: ReadonlySet<ReleaseEvent["type"]> = new Set(["CI_STATUS_REPORTED"]);

export interface CreateReleaseInput {
  version: string;
  repos: { name: string; sourceBranch: string; owner?: string }[];
  environment: "prod" | "preprod";
  createdBy: string;
}

/**
 * Applies event-specific field updates to the release *before* the state changes.
 * This is the only place that knows how a given event's payload maps onto the record.
 */
function applyEventEffects(release: Release, event: ReleaseEvent): void {
  const payload = event.payload ?? {};

  switch (event.type) {
    case "BRANCHES_CREATED": {
      const branches = (payload.branches as Record<string, string>) ?? {};
      release.repos = release.repos.map((repo) => ({
        ...repo,
        releaseBranch: branches[repo.name] ?? repo.releaseBranch ?? `release/${release.version}`,
      }));
      break;
    }
    case "TICKET_CREATED": {
      release.ticket = { id: payload.ticketId as string, url: payload.ticketUrl as string | undefined };
      break;
    }
    case "QA_APPROVAL_REQUESTED": {
      release.approvals.qa = { status: "pending" };
      break;
    }
    case "QA_APPROVED": {
      release.approvals.qa = {
        status: "approved",
        approvedBy: payload.approvedBy as string,
        approvedAt: new Date(),
        notes: payload.notes as string | undefined,
      };
      break;
    }
    case "QA_REJECTED": {
      release.approvals.qa = {
        status: "rejected",
        approvedBy: payload.rejectedBy as string | undefined,
        notes: payload.notes as string | undefined,
      };
      break;
    }
    case "CAB_APPROVAL_REQUESTED": {
      release.approvals.cab = { status: "pending" };
      break;
    }
    case "CAB_APPROVED": {
      release.approvals.cab = {
        status: "approved",
        approvedBy: payload.approvedBy as string,
        approvedAt: new Date(),
        notes: payload.notes as string | undefined,
      };
      break;
    }
    case "CAB_REJECTED": {
      release.approvals.cab = {
        status: "rejected",
        approvedBy: payload.rejectedBy as string | undefined,
        notes: payload.notes as string | undefined,
      };
      break;
    }
    case "DEPLOY_REQUESTED": {
      release.deployment = { status: "pending", startedAt: new Date() };
      break;
    }
    case "DEPLOY_SUCCEEDED": {
      release.deployment = {
        ...release.deployment,
        status: "success",
        deploymentId: (payload.deploymentId as string) ?? release.deployment?.deploymentId,
        completedAt: new Date(),
      };
      break;
    }
    case "DEPLOY_FAILED": {
      release.deployment = { ...release.deployment, status: "failed", completedAt: new Date() };
      break;
    }
    case "SANITY_STARTED": {
      release.sanity = { status: "running" };
      break;
    }
    case "SANITY_PASSED": {
      release.sanity = { status: "passed", results: payload.results as Record<string, unknown> | undefined };
      break;
    }
    case "SANITY_FAILED": {
      release.sanity = { status: "failed", results: payload.results as Record<string, unknown> | undefined };
      break;
    }
    case "ROLLBACK_REQUESTED": {
      release.rollback = { reason: payload.reason as string | undefined, requestedAt: new Date() };
      break;
    }
    case "ROLLBACK_COMPLETED": {
      release.rollback = { ...release.rollback, completedAt: new Date() };
      break;
    }
    case "TICKET_UPDATED": {
      release.ticket = {
        ...release.ticket!,
        updatedAt: new Date(),
        updateNotes: payload.notes as string | undefined,
      };
      break;
    }
    case "BACKMERGE_REQUESTED": {
      release.backmerge = { status: "pending", attempts: (release.backmerge?.attempts ?? 0) + 1 };
      break;
    }
    case "BACKMERGE_CREATED": {
      release.backmerge = { ...release.backmerge, status: "success", prUrl: payload.prUrl as string };
      break;
    }
    case "BACKMERGE_FAILED": {
      release.backmerge = { ...release.backmerge, status: "failed" };
      break;
    }
    case "TAGGING_REQUESTED": {
      release.tagging = { status: "pending", attempts: (release.tagging?.attempts ?? 0) + 1 };
      break;
    }
    case "REPOS_TAGGED": {
      const tags = (payload.tags as Record<string, string>) ?? {};
      release.repos = release.repos.map((r) => ({ ...r, tag: tags[r.name] ?? r.tag }));
      release.tagging = { ...release.tagging, status: "success" };
      break;
    }
    case "TAGGING_FAILED": {
      release.tagging = { ...release.tagging, status: "failed" };
      break;
    }
    case "CI_STATUS_REPORTED": {
      release.ci = { status: payload.status as NonNullable<Release["ci"]>["status"] };
      break;
    }
    default:
      break;
  }
}

export class ReleaseEngine {
  private readonly actionRegistry: ReturnType<typeof buildOnEnterRegistry>;

  constructor(
    private readonly store: ReleaseStore,
    actionDeps: ActionDeps = {}
  ) {
    this.actionRegistry = buildOnEnterRegistry(actionDeps);
  }

  createRelease(input: CreateReleaseInput): Release {
    const now = new Date();
    const repos: ReleaseRepo[] = input.repos.map((r) => ({ name: r.name, sourceBranch: r.sourceBranch, owner: r.owner }));

    const release: Release = {
      id: randomUUID(),
      version: input.version,
      state: "DRAFT",
      repos,
      environment: input.environment,
      approvals: {},
      ci: { status: "unknown" },
      featureFlags: [],
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };

    this.store.insertRelease(release);
    this.store.appendEvent({
      releaseId: release.id,
      type: "RELEASE_CREATED",
      payload: { version: input.version, environment: input.environment },
      actor: input.createdBy,
      fromState: "DRAFT",
      toState: "DRAFT",
      outcome: "APPLIED",
    });

    return release;
  }

  getRelease(id: string): Release {
    return this.store.getRelease(id);
  }

  listReleases(): Release[] {
    return this.store.listReleases();
  }

  getHistory(id: string) {
    return this.store.getEventLog(id);
  }

  /**
   * The transition function: transition(release, event). Boring on purpose —
   * look up the legal target, run guards, apply effects, persist, log, act.
   */
  async transition(releaseId: string, event: ReleaseEvent): Promise<Release> {
    const release = this.store.getRelease(releaseId);
    const fromState = release.state;

    if (TERMINAL_STATES.has(fromState)) {
      this.store.appendEvent({
        releaseId,
        type: event.type,
        payload: event.payload,
        actor: event.actor,
        fromState,
        toState: null,
        outcome: "REJECTED",
        reason: `release is in terminal state ${fromState}`,
      });
      throw new IllegalTransitionError(fromState, event.type);
    }

    if (SIDECAR_EVENTS.has(event.type)) {
      applyEventEffects(release, event);
      release.updatedAt = new Date();
      this.store.saveRelease(release);
      this.store.appendEvent({
        releaseId,
        type: event.type,
        payload: event.payload,
        actor: event.actor,
        fromState,
        toState: fromState,
        outcome: "APPLIED",
      });
      return release;
    }

    const target = legalTarget(fromState, event.type);
    if (!target) {
      this.store.appendEvent({
        releaseId,
        type: event.type,
        payload: event.payload,
        actor: event.actor,
        fromState,
        toState: null,
        outcome: "REJECTED",
        reason: "no legal transition for this event from the current state",
      });
      throw new IllegalTransitionError(fromState, event.type);
    }

    const guardResult = runGuards(release, event);
    if (!guardResult.ok) {
      this.store.appendEvent({
        releaseId,
        type: event.type,
        payload: event.payload,
        actor: event.actor,
        fromState,
        toState: null,
        outcome: "REJECTED",
        reason: guardResult.reasons.join("; "),
      });
      throw new GuardFailedError(fromState, event.type, guardResult.reasons);
    }

    const toState: ReleaseState =
      target === RESUME_PREVIOUS ? (release.preBlockState ?? "DRAFT") : target;

    applyEventEffects(release, event);

    if (event.type === "BLOCKED") {
      release.preBlockState = fromState;
    } else if (event.type === "UNBLOCKED") {
      release.preBlockState = undefined;
    }

    release.state = toState;
    release.updatedAt = new Date();

    this.store.saveRelease(release);
    this.store.appendEvent({
      releaseId,
      type: event.type,
      payload: event.payload,
      actor: event.actor,
      fromState,
      toState,
      outcome: "APPLIED",
    });

    await runActions(release, event, fromState, this.actionRegistry);

    return release;
  }
}
