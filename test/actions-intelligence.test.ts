import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openDb } from "../src/db.js";
import { ReleaseStore } from "../src/store.js";
import { ReleaseEngine } from "../src/engine.js";
import { loadWorkflowConfig } from "../src/workflow/loader.js";
import { WorkflowExecutor } from "../src/workflow/executor.js";
import { IntelligenceServiceError } from "../src/errors.js";
import type { IntelligenceProvider } from "../src/intelligence/types.js";

function makeFakeIntelligence(): IntelligenceProvider & {
  generateTicketDescription: ReturnType<typeof vi.fn>;
  extractTicketKeys: ReturnType<typeof vi.fn>;
  generateReleaseNotes: ReturnType<typeof vi.fn>;
} {
  return {
    generateTicketDescription: vi.fn().mockResolvedValue("Drafted ticket description."),
    extractTicketKeys: vi.fn().mockResolvedValue([]),
    summarizeChanges: vi.fn(),
    generateReleaseNotes: vi.fn().mockResolvedValue("Drafted release notes."),
    identifyAffectedComponents: vi.fn(),
    suggestSanityTests: vi.fn(),
    summarizeFailure: vi.fn(),
  };
}

async function confirmReleasePr(workflow: WorkflowExecutor, releaseId: string) {
  await workflow.advance(releaseId, {
    type: "RELEASE_PR_CREATED",
    actor: "sam",
    payload: { prUrls: { web: "https://github.com/ipsy/web/pull/9" } },
  });
}

describe("intelligence wired into pipeline actions", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("drafts and prints a ticket description on entering CHANGE_TICKET_CREATED", async () => {
    const intelligence = makeFakeIntelligence();
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")), { intelligence });
    const workflow = new WorkflowExecutor(engine, loadWorkflowConfig("config/pipeline.yaml"));

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
    await confirmReleasePr(workflow, release.id);
    await workflow.advance(release.id, { type: "TICKET_CREATED", actor: "sam", payload: { ticketId: "PCM-1" } });

    expect(intelligence.generateTicketDescription).toHaveBeenCalledWith(
      expect.objectContaining({
        release: expect.objectContaining({ id: release.id }),
        tickets: expect.any(Array),
      })
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Drafted ticket description."));
  });

  it("does not call the intelligence provider when none is configured", async () => {
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")));
    const workflow = new WorkflowExecutor(engine, loadWorkflowConfig("config/pipeline.yaml"));

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
    await confirmReleasePr(workflow, release.id);
    const { release: after } = await workflow.advance(release.id, {
      type: "TICKET_CREATED",
      actor: "sam",
      payload: { ticketId: "PCM-1" },
    });

    expect(after.state).toBe("QA_APPROVAL_PENDING");
  });

  it("logs an error and does not block the transition when the SLM call fails", async () => {
    const intelligence = makeFakeIntelligence();
    intelligence.generateTicketDescription.mockRejectedValue(new IntelligenceServiceError("server unreachable"));
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")), { intelligence });
    const workflow = new WorkflowExecutor(engine, loadWorkflowConfig("config/pipeline.yaml"));

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
    await confirmReleasePr(workflow, release.id);
    const { release: after } = await workflow.advance(release.id, {
      type: "TICKET_CREATED",
      actor: "sam",
      payload: { ticketId: "PCM-1" },
    });

    expect(after.state).toBe("QA_APPROVAL_PENDING");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("intelligence.generateTicketDescription"),
      expect.stringContaining("server unreachable")
    );
  });

  it("drafts and prints release notes on entering FINALIZING", async () => {
    const intelligence = makeFakeIntelligence();
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")), { intelligence });
    const workflow = new WorkflowExecutor(engine, loadWorkflowConfig("config/pipeline.yaml"));

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
    await confirmReleasePr(workflow, release.id);
    await workflow.advance(release.id, { type: "TICKET_CREATED", actor: "sam", payload: { ticketId: "PCM-1" } });
    await workflow.advance(release.id, { type: "QA_APPROVED", actor: "qa-bot", payload: { approvedBy: "qa-lead" } });
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

    expect(intelligence.generateReleaseNotes).toHaveBeenCalledWith(
      expect.objectContaining({ release: expect.objectContaining({ id: release.id, state: "FINALIZING" }) })
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Drafted release notes."));
  });
});
