import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { legalTarget } from "../transitions.js";
import { WorkflowConfigError } from "../errors.js";
import type { WorkflowConfig, WorkflowStep } from "./schema.js";

function assertStepShape(raw: unknown, index: number): asserts raw is WorkflowStep {
  const id = (raw as { id?: unknown })?.id;
  const label = typeof id === "string" ? id : `#${index}`;

  if (typeof raw !== "object" || raw === null) {
    throw new WorkflowConfigError(label, "step is not an object");
  }
  const step = raw as Record<string, unknown>;

  const requiredStrings: (keyof WorkflowStep)[] = ["id", "name", "fromState", "event", "resultState"];
  for (const field of requiredStrings) {
    if (typeof step[field] !== "string" || step[field] === "") {
      throw new WorkflowConfigError(label, `field "${field}" must be a non-empty string`);
    }
  }
  if (typeof step.step !== "number") {
    throw new WorkflowConfigError(label, `field "step" must be a number`);
  }
  if (typeof step.wait !== "boolean") {
    throw new WorkflowConfigError(label, `field "wait" must be a boolean`);
  }
  if (step.onFailure !== undefined) {
    const failure = step.onFailure as Record<string, unknown>;
    for (const field of ["event", "resultState", "retryEvent"]) {
      if (typeof failure?.[field] !== "string" || failure[field] === "") {
        throw new WorkflowConfigError(label, `onFailure.${field} must be a non-empty string`);
      }
    }
  }
}

/**
 * Loads and validates a workflow config against the *real* transition table, so the YAML
 * can never silently drift from what the engine actually allows. Any step referencing a
 * state/event that doesn't exist, or expecting the wrong result state, fails loudly here
 * rather than at runtime mid-release.
 */
export function loadWorkflowConfig(path: string): WorkflowConfig {
  const raw = parse(readFileSync(path, "utf8"));
  const rawSteps = (raw as { steps?: unknown[] })?.steps;
  if (!Array.isArray(rawSteps)) {
    throw new WorkflowConfigError("<root>", `config at "${path}" must have a top-level "steps" array`);
  }

  const seenIds = new Set<string>();

  rawSteps.forEach((rawStep, index) => {
    assertStepShape(rawStep, index);
    const step = rawStep;

    if (seenIds.has(step.id)) {
      throw new WorkflowConfigError(step.id, "duplicate step id");
    }
    seenIds.add(step.id);

    const target = legalTarget(step.fromState, step.event);
    if (target === undefined) {
      throw new WorkflowConfigError(
        step.id,
        `event "${step.event}" is not a legal transition from "${step.fromState}" (check transitions.ts)`
      );
    }
    if (target !== step.resultState) {
      throw new WorkflowConfigError(
        step.id,
        `event "${step.event}" from "${step.fromState}" resolves to "${target}", not "${step.resultState}"`
      );
    }

    if (step.onFailure) {
      const { event: failureEvent, resultState: failureState, retryEvent } = step.onFailure;
      const failureTarget = legalTarget(step.fromState, failureEvent);
      if (failureTarget === undefined) {
        throw new WorkflowConfigError(
          step.id,
          `onFailure.event "${failureEvent}" is not a legal transition from "${step.fromState}"`
        );
      }
      if (failureTarget !== failureState) {
        throw new WorkflowConfigError(
          step.id,
          `onFailure.event "${failureEvent}" from "${step.fromState}" resolves to "${failureTarget}", not "${failureState}"`
        );
      }
      const retryTarget = legalTarget(failureState, retryEvent);
      if (retryTarget !== step.fromState) {
        throw new WorkflowConfigError(
          step.id,
          `onFailure.retryEvent "${retryEvent}" from "${failureState}" must resolve back to "${step.fromState}"`
        );
      }
    }
  });

  return { steps: rawSteps as WorkflowStep[] };
}
