import { describe, it, expect, beforeEach } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { ReleaseStore } from "../src/store.js";
import { ReleaseEngine } from "../src/engine.js";
import { loadWorkflowConfig } from "../src/workflow/loader.js";
import { WorkflowExecutor } from "../src/workflow/executor.js";
import { WorkflowConfigError, GuardFailedError } from "../src/errors.js";

const PIPELINE_PATH = "config/pipeline.yaml";

function makeEngine(): ReleaseEngine {
  const db = openDb(":memory:");
  return new ReleaseEngine(new ReleaseStore(db));
}

function makeWorkflow(engine: ReleaseEngine): WorkflowExecutor {
  return new WorkflowExecutor(engine, loadWorkflowConfig(PIPELINE_PATH));
}

/** Drives a fresh release all the way to BACKMERGE_PENDING via the shipped pipeline config. */
async function driveToBackmergePending(engine: ReleaseEngine, workflow: WorkflowExecutor) {
  const release = engine.createRelease({
    version: "1.0.0",
    repos: [{ name: "web", sourceBranch: "main" }],
    environment: "prod",
    createdBy: "sam",
  });

  await workflow.advance(release.id, {
    type: "BRANCHES_CREATED",
    actor: "sam",
    payload: { branches: { web: "release/1.0.0" } },
  });
  await workflow.advance(release.id, { type: "TICKET_CREATED", actor: "sam", payload: { ticketId: "PCM-1" } });
  await workflow.advance(release.id, {
    type: "QA_APPROVED",
    actor: "qa-bot",
    payload: { approvedBy: "qa-lead" },
  });
  await workflow.advance(release.id, {
    type: "CAB_APPROVED",
    actor: "cab-bot",
    payload: { approvedBy: "cab-lead" },
  });
  await workflow.advance(release.id, { type: "CI_STATUS_REPORTED", actor: "ci-bot", payload: { status: "green" } });
  await workflow.advance(release.id, { type: "READY_CHECK_PASSED", actor: "sam" });
  await workflow.advance(release.id, {
    type: "DEPLOY_SUCCEEDED",
    actor: "deploy-bot",
    payload: { deploymentId: "dep-1" },
  });
  await workflow.advance(release.id, { type: "SANITY_PASSED", actor: "test-bot", payload: {} });
  const { release: afterTicketUpdate } = await workflow.advance(release.id, {
    type: "TICKET_UPDATED",
    actor: "jira-bot",
    payload: { notes: "release notes attached" },
  });

  return { releaseId: release.id, release: afterTicketUpdate };
}

describe("workflow config loader", () => {
  it("accepts the shipped pipeline config and matches every step against the real transition table", () => {
    expect(() => loadWorkflowConfig(PIPELINE_PATH)).not.toThrow();
  });

  it("rejects a config step referencing a nonexistent event", () => {
    const dir = mkdtempSync(join(tmpdir(), "workflow-test-"));
    const badConfigPath = join(dir, "bad-pipeline.yaml");
    writeFileSync(
      badConfigPath,
      `
steps:
  - id: bogus
    step: 1
    name: Bogus step
    fromState: DRAFT
    event: NOT_A_REAL_EVENT
    resultState: BRANCH_CREATED
    wait: false
`
    );

    expect(() => loadWorkflowConfig(badConfigPath)).toThrow(WorkflowConfigError);
  });

  it("rejects a config step whose resultState doesn't match what the event actually produces", () => {
    const dir = mkdtempSync(join(tmpdir(), "workflow-test-"));
    const badConfigPath = join(dir, "bad-pipeline.yaml");
    writeFileSync(
      badConfigPath,
      `
steps:
  - id: mismatched
    step: 1
    name: Mismatched result state
    fromState: DRAFT
    event: BRANCHES_CREATED
    resultState: COMPLETE
    wait: false
`
    );

    expect(() => loadWorkflowConfig(badConfigPath)).toThrow(WorkflowConfigError);
  });
});

describe("WorkflowExecutor.advance", () => {
  let engine: ReleaseEngine;
  let workflow: WorkflowExecutor;

  beforeEach(() => {
    engine = makeEngine();
    workflow = makeWorkflow(engine);
  });

  it("auto-advances through consecutive non-wait steps and stops at the next WAIT", async () => {
    const release = engine.createRelease({
      version: "1.0.0",
      repos: [{ name: "web", sourceBranch: "main" }],
      environment: "prod",
      createdBy: "sam",
    });
    await workflow.advance(release.id, {
      type: "BRANCHES_CREATED",
      actor: "sam",
      payload: { branches: { web: "release/1.0.0" } },
    });
    await workflow.advance(release.id, { type: "TICKET_CREATED", actor: "sam", payload: { ticketId: "PCM-1" } });

    const { release: afterQaApproval, fired } = await workflow.advance(release.id, {
      type: "QA_APPROVED",
      actor: "qa-bot",
      payload: { approvedBy: "qa-lead" },
    });

    expect(fired.map((f) => f.event)).toContain("CAB_APPROVAL_REQUESTED");
    expect(afterQaApproval.state).toBe("CAB_APPROVAL_PENDING");
    // The chain must stop at the WAIT point, not also fire CAB_APPROVED.
    expect(fired.map((f) => f.event)).not.toContain("CAB_APPROVED");
  });

  it("propagates a guard failure without mutating release state or swallowing it into BLOCKED", async () => {
    const release = engine.createRelease({
      version: "1.0.0",
      repos: [],
      environment: "prod",
      createdBy: "sam",
    });

    await expect(
      workflow.advance(release.id, { type: "BRANCHES_CREATED", actor: "sam", payload: {} })
    ).rejects.toThrow(GuardFailedError);

    expect(engine.getRelease(release.id).state).toBe("DRAFT");
  });

  it("tracks CI_STATUS_REPORTED without moving release state", async () => {
    const release = engine.createRelease({
      version: "1.0.0",
      repos: [{ name: "web", sourceBranch: "main" }],
      environment: "prod",
      createdBy: "sam",
    });

    const { release: reported } = await workflow.advance(release.id, {
      type: "CI_STATUS_REPORTED",
      actor: "ci-bot",
      payload: { status: "green" },
    });

    expect(reported.state).toBe("DRAFT");
    expect(reported.ci?.status).toBe("green");

    const history = engine.getHistory(release.id);
    const ciEvent = history.find((h) => h.type === "CI_STATUS_REPORTED");
    expect(ciEvent?.fromState).toBe("DRAFT");
    expect(ciEvent?.toState).toBe("DRAFT");
    expect(ciEvent?.outcome).toBe("APPLIED");
  });

  it("tracks backmerge PR creation with independent failure/retry (step 10)", async () => {
    const { releaseId, release } = await driveToBackmergePending(engine, workflow);
    expect(release.state).toBe("BACKMERGE_PENDING");

    const { release: afterFailure } = await workflow.advance(releaseId, {
      type: "BACKMERGE_FAILED",
      actor: "github-bot",
    });
    expect(afterFailure.state).toBe("BACKMERGE_FAILED");
    expect(afterFailure.backmerge?.status).toBe("failed");

    const { release: afterRetry } = await workflow.advance(releaseId, { type: "RETRY_BACKMERGE", actor: "sam" });
    expect(afterRetry.state).toBe("BACKMERGE_PENDING");

    const { release: afterCreated, fired } = await workflow.advance(releaseId, {
      type: "BACKMERGE_CREATED",
      actor: "github-bot",
      payload: { prUrl: "https://github.com/ipsy/web/pull/42" },
    });

    expect(afterCreated.backmerge?.prUrl).toBe("https://github.com/ipsy/web/pull/42");
    // Retrying the backmerge must not have replayed any tagging step before this point,
    // and success here should auto-advance straight into tagging.
    expect(afterCreated.state).toBe("TAGGING_PENDING");
    expect(fired.map((f) => f.event)).toContain("TAGGING_REQUESTED");
  });

  it("tracks repo tagging with independent failure/retry (step 11) and only sets tags on success", async () => {
    const { releaseId } = await driveToBackmergePending(engine, workflow);
    await workflow.advance(releaseId, {
      type: "BACKMERGE_CREATED",
      actor: "github-bot",
      payload: { prUrl: "https://github.com/ipsy/web/pull/42" },
    });

    const { release: afterFailure } = await workflow.advance(releaseId, {
      type: "TAGGING_FAILED",
      actor: "github-bot",
    });
    expect(afterFailure.state).toBe("TAGGING_FAILED");
    expect(afterFailure.repos.find((r) => r.name === "web")?.tag).toBeUndefined();

    await workflow.advance(releaseId, { type: "RETRY_TAGGING", actor: "sam" });

    const { release: afterTagged, fired } = await workflow.advance(releaseId, {
      type: "REPOS_TAGGED",
      actor: "github-bot",
      payload: { tags: { web: "v1.0.0" } },
    });

    expect(afterTagged.repos.find((r) => r.name === "web")?.tag).toBe("v1.0.0");
    expect(afterTagged.state).toBe("COMPLETE");
    expect(fired.map((f) => f.event)).toContain("RELEASE_FINALIZED");
  });
});

describe("WorkflowExecutor.describeStatus", () => {
  it("reports a failed sub-step with its retry event", async () => {
    const engine = makeEngine();
    const workflow = makeWorkflow(engine);
    const { releaseId } = await driveToBackmergePending(engine, workflow);
    await workflow.advance(releaseId, {
      type: "BACKMERGE_CREATED",
      actor: "github-bot",
      payload: { prUrl: "https://github.com/ipsy/web/pull/42" },
    });
    const { release } = await workflow.advance(releaseId, { type: "TAGGING_FAILED", actor: "github-bot" });

    const status = workflow.describeStatus(release);

    expect(status).toMatchObject({ phase: "failed", step: 11, retryEvent: "RETRY_TAGGING" });
  });

  it("reports a terminal release", async () => {
    const engine = makeEngine();
    const workflow = makeWorkflow(engine);
    const { releaseId } = await driveToBackmergePending(engine, workflow);
    await workflow.advance(releaseId, {
      type: "BACKMERGE_CREATED",
      actor: "github-bot",
      payload: { prUrl: "https://github.com/ipsy/web/pull/42" },
    });
    const { release } = await workflow.advance(releaseId, {
      type: "REPOS_TAGGED",
      actor: "github-bot",
      payload: { tags: { web: "v1.0.0" } },
    });

    expect(workflow.describeStatus(release)).toEqual({ phase: "terminal", state: "COMPLETE" });
  });
});
