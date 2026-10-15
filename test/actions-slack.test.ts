import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openDb } from "../src/db.js";
import { ReleaseStore } from "../src/store.js";
import { ReleaseEngine } from "../src/engine.js";
import { loadWorkflowConfig } from "../src/workflow/loader.js";
import { WorkflowExecutor } from "../src/workflow/executor.js";
import type { SlackProvider } from "../src/slack/types.js";

async function driveToTicketCreated(workflow: WorkflowExecutor, releaseId: string) {
  await workflow.advance(releaseId, {
    type: "BRANCHES_CREATED",
    actor: "sam",
    payload: { branches: { web: "release/1.0.0" } },
  });
  await workflow.advance(releaseId, {
    type: "RELEASE_PR_CREATED",
    actor: "sam",
    payload: { prUrls: { web: "https://github.com/ipsy/web/pull/9" } },
  });
  return workflow.advance(releaseId, { type: "TICKET_CREATED", actor: "sam", payload: { ticketId: "PCM-1" } });
}

function makeFakeSlack(): SlackProvider & {
  postMessage: ReturnType<typeof vi.fn>;
  listThreadReplies: ReturnType<typeof vi.fn>;
  getUser: ReturnType<typeof vi.fn>;
  authTest: ReturnType<typeof vi.fn>;
} {
  return {
    postMessage: vi.fn().mockResolvedValue({
      ts: "1710000000.000100",
      channel: "C123",
      url: "https://slack.com/archives/C123/p1710000000000100",
    }),
    listThreadReplies: vi.fn().mockResolvedValue([]),
    getUser: vi.fn(),
    authTest: vi.fn(),
  };
}

describe("Slack actions wired via ReleaseEngine", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("posts a QA approval request and stores the Slack thread on the release", async () => {
    const slack = makeFakeSlack();
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")), {
      slack,
      slackChannelPcmApproval: "C123",
    });
    const workflow = new WorkflowExecutor(engine, loadWorkflowConfig("config/pipeline.yaml"));
    const release = engine.createRelease({
      version: "1.0.0",
      repos: [{ name: "web", sourceBranch: "main" }],
      environment: "prod",
      createdBy: "sam",
    });
    const { release: after } = await driveToTicketCreated(workflow, release.id);

    expect(after.state).toBe("QA_APPROVAL_PENDING");
    expect(slack.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        text: expect.stringContaining("needs QA approval"),
      })
    );
    expect(engine.getRelease(release.id).approvals.qa).toMatchObject({
      status: "pending",
      slackChannel: "C123",
      slackTs: "1710000000.000100",
    });
  });

  it("skips Slack when it is not configured", async () => {
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")));
    const workflow = new WorkflowExecutor(engine, loadWorkflowConfig("config/pipeline.yaml"));
    const release = engine.createRelease({
      version: "1.0.0",
      repos: [{ name: "web", sourceBranch: "main" }],
      environment: "prod",
      createdBy: "sam",
    });
    const { release: after } = await driveToTicketCreated(workflow, release.id);
    expect(after.state).toBe("QA_APPROVAL_PENDING");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("skipped: Slack integration not configured"),
      expect.anything()
    );
  });
});
