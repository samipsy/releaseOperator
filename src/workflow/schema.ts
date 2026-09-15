import type { ReleaseEventType, ReleaseState } from "../types.js";

export interface WorkflowFailure {
  event: ReleaseEventType;
  resultState: ReleaseState;
  retryEvent: ReleaseEventType;
}

export interface WorkflowStep {
  id: string;
  step: number;
  name: string;
  fromState: ReleaseState;
  event: ReleaseEventType;
  resultState: ReleaseState;
  wait: boolean;
  actor?: string;
  payload?: Record<string, unknown>;
  outputs?: string[];
  onFailure?: WorkflowFailure;
}

export interface WorkflowConfig {
  steps: WorkflowStep[];
}
