export class IllegalTransitionError extends Error {
  constructor(public readonly state: string, public readonly event: string) {
    super(`Event "${event}" is not valid from state "${state}"`);
    this.name = "IllegalTransitionError";
  }
}

export class GuardFailedError extends Error {
  constructor(public readonly state: string, public readonly event: string, public readonly reasons: string[]) {
    super(`Event "${event}" from state "${state}" blocked by guards: ${reasons.join("; ")}`);
    this.name = "GuardFailedError";
  }
}

export class ReleaseNotFoundError extends Error {
  constructor(public readonly releaseId: string) {
    super(`Release "${releaseId}" not found`);
    this.name = "ReleaseNotFoundError";
  }
}

export class WorkflowConfigError extends Error {
  constructor(public readonly stepId: string, reason: string) {
    super(`Workflow config step "${stepId}" is invalid: ${reason}`);
    this.name = "WorkflowConfigError";
  }
}

export class WorkflowExecutionError extends Error {
  constructor(public readonly releaseId: string, visited: string[]) {
    super(`Workflow execution for release "${releaseId}" exceeded max hops: ${visited.join(" -> ")}`);
    this.name = "WorkflowExecutionError";
  }
}

export class IntelligenceServiceError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "IntelligenceServiceError";
  }
}

export class GithubServiceError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "GithubServiceError";
  }
}

export class JiraServiceError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "JiraServiceError";
  }
}

export class SlackServiceError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "SlackServiceError";
  }
}

export class NetlifyServiceError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "NetlifyServiceError";
  }
}
