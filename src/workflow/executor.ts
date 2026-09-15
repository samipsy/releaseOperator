import type { Release, ReleaseEvent, ReleaseEventType, ReleaseState } from "../types.js";
import { SIDECAR_EVENTS, type ReleaseEngine } from "../engine.js";
import { WorkflowExecutionError } from "../errors.js";
import type { WorkflowConfig, WorkflowStep } from "./schema.js";

const MAX_HOPS = 25;

const TERMINAL_STATES: ReadonlySet<ReleaseState> = new Set(["COMPLETE", "ROLLED_BACK", "CANCELLED"]);

export type WorkflowStatus =
  | { phase: "terminal"; state: ReleaseState }
  | { phase: "waiting" | "ready"; state: ReleaseState; step: number; name: string; expectedEvent: ReleaseEventType }
  | { phase: "failed"; state: ReleaseState; step: number; name: string; retryEvent: ReleaseEventType }
  | { phase: "unmodeled"; state: ReleaseState };

export interface FiredHop {
  event: ReleaseEventType;
  resultState: ReleaseState;
}

export interface AdvanceResult {
  release: Release;
  fired: FiredHop[];
}

/**
 * Walks a WorkflowConfig on top of ReleaseEngine: applies an incoming event, then auto-fires
 * consecutive non-wait steps until hitting a wait point, a terminal state, or a state the
 * config doesn't model. Never invents behavior beyond what the config + engine already allow —
 * an unexpected guard/transition failure during auto-fire propagates rather than being masked.
 */
export class WorkflowExecutor {
  constructor(
    private readonly engine: ReleaseEngine,
    private readonly config: WorkflowConfig
  ) {}

  private findStepByFromState(state: ReleaseState): WorkflowStep | undefined {
    return this.config.steps.find((s) => s.fromState === state);
  }

  private findStepByFailureState(state: ReleaseState): WorkflowStep | undefined {
    return this.config.steps.find((s) => s.onFailure?.resultState === state);
  }

  async advance(releaseId: string, event: ReleaseEvent): Promise<AdvanceResult> {
    let release = await this.engine.transition(releaseId, event);
    const fired: FiredHop[] = [];

    // Sidecar events (e.g. CI_STATUS_REPORTED) are passive field updates, not a "step
    // completed, continue please" signal — they must never themselves trigger auto-advance.
    if (SIDECAR_EVENTS.has(event.type)) {
      return { release, fired };
    }

    const visited: ReleaseState[] = [release.state];

    while (!TERMINAL_STATES.has(release.state)) {
      const step = this.findStepByFromState(release.state);
      if (!step || step.wait) break;

      if (visited.length > MAX_HOPS) {
        throw new WorkflowExecutionError(releaseId, visited);
      }

      release = await this.engine.transition(releaseId, {
        type: step.event,
        payload: step.payload ?? {},
        actor: step.actor ?? "workflow-executor",
      });
      fired.push({ event: step.event, resultState: release.state });
      visited.push(release.state);
    }

    return { release, fired };
  }

  describeStatus(release: Release): WorkflowStatus {
    if (TERMINAL_STATES.has(release.state)) {
      return { phase: "terminal", state: release.state };
    }

    const step = this.findStepByFromState(release.state);
    if (step) {
      return {
        phase: step.wait ? "waiting" : "ready",
        state: release.state,
        step: step.step,
        name: step.name,
        expectedEvent: step.event,
      };
    }

    const failedStep = this.findStepByFailureState(release.state);
    if (failedStep?.onFailure) {
      return {
        phase: "failed",
        state: release.state,
        step: failedStep.step,
        name: failedStep.name,
        retryEvent: failedStep.onFailure.retryEvent,
      };
    }

    return { phase: "unmodeled", state: release.state };
  }
}
