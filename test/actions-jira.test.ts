import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openDb } from "../src/db.js";
import { ReleaseStore } from "../src/store.js";
import { ReleaseEngine } from "../src/engine.js";
import { loadWorkflowConfig } from "../src/workflow/loader.js";
import { WorkflowExecutor } from "../src/workflow/executor.js";
import type { JiraProvider } from "../src/jira/types.js";
import { PCM_AFFECTED_SERVICE_ARI } from "../src/jira/pcmChangeFields.js";

const RELEASE_PR_PAYLOAD = { prUrls: { web: "https://github.com/ipsy/web/pull/9" } };

async function confirmReleasePr(workflow: WorkflowExecutor, releaseId: string) {
  return workflow.advance(releaseId, {
    type: "RELEASE_PR_CREATED",
    actor: "sam",
    payload: RELEASE_PR_PAYLOAD,
  });
}

function makeFakeJira(): JiraProvider & {
  createIssue: ReturnType<typeof vi.fn>;
  addComment: ReturnType<typeof vi.fn>;
  getIssue: ReturnType<typeof vi.fn>;
  getMyself: ReturnType<typeof vi.fn>;
  createIssueLink: ReturnType<typeof vi.fn>;
  searchServices?: ReturnType<typeof vi.fn>;
} {
  return {
    createIssue: vi.fn().mockResolvedValue({ key: "PCM-99", url: "https://ipsycorp.atlassian.net/browse/PCM-99", raw: "{}" }),
    addComment: vi.fn().mockResolvedValue({ raw: "{}" }),
    getIssue: vi.fn().mockResolvedValue({ key: "PCM-1", summary: "Fix checkout", description: "Users could not pay." }),
    getMyself: vi.fn().mockResolvedValue({ accountId: "acct-sam" }),
    createIssueLink: vi.fn().mockResolvedValue({ raw: "" }),
  };
}

describe("real Jira actions wired via ReleaseEngine", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("creates a Jira issue on entering TICKET_CREATE_PENDING and auto-advances past ticket confirm", async () => {
    const jira = makeFakeJira();
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")), {
      jira,
      jiraProjectKey: "PCM",
      jiraParentKey: "PCM-10",
    });
    const workflow = new WorkflowExecutor(engine, loadWorkflowConfig("config/pipeline.yaml"));

    const release = engine.createRelease({
      version: "1.0.0",
      repos: [{ name: "web", sourceBranch: "main" }],
      environment: "prod",
      createdBy: "sam",
      bump: "minor",
      plannedStart: "2026-10-02 10:00",
      plannedEnd: "2026-10-02 11:00",
      affectedServices: ["ari:cloud:graph::service/test/web"],
    });
    const { release: branched } = await workflow.advance(release.id, {
      type: "BRANCHES_CREATED",
      actor: "sam",
      payload: { branches: { web: "release/1.0.0" } },
    });
    expect(branched.state).toBe("RELEASE_PR_PENDING");
    const { release: after } = await confirmReleasePr(workflow, release.id);

    expect(after.state).toBe("QA_APPROVAL_PENDING");
    expect(jira.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        projectKey: "PCM",
        issueType: "Task",
        parentKey: "PCM-10",
        summary: "New release of web to 1.0.0",
        extraFields: expect.objectContaining({
          customfield_10034: { value: "Low" },
          customfield_10035: { value: "New functionality" },
          customfield_10130: "https://github.com/ipsy/web/pull/9",
          customfield_10486: "Redeploy prev versions",
          customfield_10081: [{ id: PCM_AFFECTED_SERVICE_ARI }],
          labels: ["CAB-Bug-Fix", "CAB-MX", "CAB-NewPlatform", "CAB-US/CA"],
          assignee: { accountId: "acct-sam" },
          reporter: { accountId: "acct-sam" },
        }),
      })
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("PCM-99"));
    expect(engine.getRelease(release.id).ticket).toEqual({
      id: "PCM-99",
      url: "https://ipsycorp.atlassian.net/browse/PCM-99",
    });
    expect(after.ticket).toEqual({
      id: "PCM-99",
      url: "https://ipsycorp.atlassian.net/browse/PCM-99",
    });
  });

  it("uses a release-notes table as the ticket body even when intelligence is also configured", async () => {
    const jira = makeFakeJira();
    const intelligence = {
      generateTicketDescription: vi.fn().mockResolvedValue("Drafted body."),
      extractTicketKeys: vi.fn().mockResolvedValue([]),
      summarizeChanges: vi.fn(),
      generateReleaseNotes: vi.fn(),
      identifyAffectedComponents: vi.fn(),
      suggestSanityTests: vi.fn(),
      summarizeFailure: vi.fn(),
    };
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")), {
      jira,
      jiraProjectKey: "PCM",
      intelligence,
    });
    const workflow = new WorkflowExecutor(engine, loadWorkflowConfig("config/pipeline.yaml"));

    const release = engine.createRelease({
      version: "1.0.0",
      repos: [{ name: "web", sourceBranch: "main" }],
      environment: "prod",
      createdBy: "sam",
      bump: "minor",
      plannedStart: "2026-10-02 10:00",
      plannedEnd: "2026-10-02 11:00",
      affectedServices: ["ari:cloud:graph::service/test/web"],
    });
    await workflow.advance(release.id, {
      type: "BRANCHES_CREATED",
      actor: "sam",
      payload: { branches: { web: "release/1.0.0" } },
    });
    await confirmReleasePr(workflow, release.id);

    const input = jira.createIssue.mock.calls[0]?.[0] as {
      description: string;
      extraFields: Record<string, unknown>;
    };
    expect(input.description).toContain("**Why Change is Needed/Change Description:**");
    expect(input.description).toContain("**Environment(s) Affected:** Prod - US/MX");
    expect(input.description).toContain("**Systems/Applications Impacted:** Web");
    expect(input.description).not.toContain("Drafted body.");
    expect(input.extraFields).not.toHaveProperty("environment");
    expect(input.extraFields.customfield_10130).toBe("https://github.com/ipsy/web/pull/9");
    expect(input.extraFields.customfield_10486).toBe("Redeploy prev versions");
    expect(input.extraFields.customfield_10081).toEqual([{ id: PCM_AFFECTED_SERVICE_ARI }]);
  });

  it("compares the release branch to main, loads Jira tickets, and includes them in the description", async () => {
    const jira = makeFakeJira();
    jira.getIssue.mockImplementation(async (key: string) => ({
      key,
      summary: "Glow bag copy",
      description: "Bag copy was wrong.",
    }));
    const github = {
      createReleaseBranch: vi.fn().mockResolvedValue({ ref: "refs/heads/release/1.0.0", sha: "abc", raw: "{}" }),
      createBackmergePullRequest: vi
        .fn()
        .mockResolvedValue({ url: "https://github.com/ipsy/web/pull/9", number: 9, raw: "{}" }),
      getPullRequest: vi.fn(),
      updatePullRequest: vi.fn(),
      tagReleaseBranch: vi.fn(),
      listCommitsAhead: vi.fn().mockResolvedValue([{ sha: "deadbeef01", message: "PCM-7 fix glow bag copy" }]),
      latestTagName: vi.fn(),
      readFile: vi.fn().mockResolvedValue(undefined),
      readFileMeta: vi.fn(),
      commitFile: vi.fn(),
      listDirectory: vi.fn().mockResolvedValue([]),
      listPullRequestsForCommit: vi.fn().mockResolvedValue([]),
    };
    const intelligence = {
      generateTicketDescription: vi.fn().mockResolvedValue("Release includes PCM-7."),
      extractTicketKeys: vi.fn().mockResolvedValue(["PCM-7"]),
      summarizeChanges: vi.fn(),
      generateReleaseNotes: vi.fn(),
      identifyAffectedComponents: vi.fn(),
      suggestSanityTests: vi.fn(),
      summarizeFailure: vi.fn(),
    };
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")), {
      jira,
      jiraProjectKey: "PCM",
      github,
      intelligence,
    });
    const workflow = new WorkflowExecutor(engine, loadWorkflowConfig("config/pipeline.yaml"));

    const release = engine.createRelease({
      version: "1.0.0",
      repos: [{ name: "web", owner: "ipsy", sourceBranch: "main" }],
      environment: "prod",
      createdBy: "sam",
      bump: "minor",
      plannedStart: "2026-10-02 10:00",
      plannedEnd: "2026-10-02 11:00",
      affectedServices: ["ari:cloud:graph::service/test/web"],
    });
    await workflow.advance(release.id, {
      type: "BRANCHES_CREATED",
      actor: "sam",
      payload: { branches: { web: "release/1.0.0" } },
    });

    expect(github.listCommitsAhead).toHaveBeenCalledWith({
      owner: "ipsy",
      repo: "web",
      base: "main",
      head: "release/1.0.0",
    });
    expect(intelligence.extractTicketKeys).toHaveBeenCalled();
    expect(jira.getIssue).toHaveBeenCalledWith("PCM-7");
    expect(intelligence.generateTicketDescription).toHaveBeenCalledWith(
      expect.objectContaining({
        tickets: [expect.objectContaining({ key: "PCM-7", summary: "Glow bag copy" })],
      })
    );
    expect(jira.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringMatching(/\| Ticket \| Description \| PRs \|[\s\S]*PCM/),
      })
    );
    expect(jira.createIssueLink).toHaveBeenCalledWith({
      inwardIssue: "PCM-7",
      outwardIssue: "PCM-99",
      type: "Relates",
    });
  });

  it("logs an error and does not block the transition when Jira project key is unset", async () => {
    const jira = makeFakeJira();
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")), { jira });
    const workflow = new WorkflowExecutor(engine, loadWorkflowConfig("config/pipeline.yaml"));

    const release = engine.createRelease({
      version: "1.0.0",
      repos: [{ name: "web", sourceBranch: "main" }],
      environment: "prod",
      createdBy: "sam",
      bump: "minor",
      plannedStart: "2026-10-02 10:00",
      plannedEnd: "2026-10-02 11:00",
      affectedServices: ["ari:cloud:graph::service/test/web"],
    });
    await workflow.advance(release.id, {
      type: "BRANCHES_CREATED",
      actor: "sam",
      payload: { branches: { web: "release/1.0.0" } },
    });
    const { release: after } = await confirmReleasePr(workflow, release.id);

    expect(after.state).toBe("TICKET_CREATE_PENDING");
    expect(jira.createIssue).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("RELEASE_OPERATOR_JIRA_PROJECT_KEY"));
  });

  it("posts release notes as a comment on the real ticket when entering FINALIZING", async () => {
    const jira = makeFakeJira();
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")), { jira, jiraProjectKey: "PCM" });
    const workflow = new WorkflowExecutor(engine, loadWorkflowConfig("config/pipeline.yaml"));

    const release = engine.createRelease({
      version: "1.0.0",
      repos: [{ name: "web", sourceBranch: "main" }],
      environment: "prod",
      createdBy: "sam",
      bump: "minor",
      plannedStart: "2026-10-02 10:00",
      plannedEnd: "2026-10-02 11:00",
      affectedServices: ["ari:cloud:graph::service/test/web"],
    });
    await workflow.advance(release.id, {
      type: "BRANCHES_CREATED",
      actor: "sam",
      payload: { branches: { web: "release/1.0.0" } },
    });
    await confirmReleasePr(workflow, release.id);
    await workflow.advance(release.id, { type: "QA_APPROVED", actor: "qa-bot", payload: { approvedBy: "qa-lead" } });
    await workflow.advance(release.id, { type: "CAB_APPROVED", actor: "cab-bot", payload: { approvedBy: "cab-lead" } });
    await workflow.advance(release.id, { type: "CI_STATUS_REPORTED", actor: "ci-bot", payload: { status: "green" } });
    await workflow.advance(release.id, { type: "READY_CHECK_PASSED", actor: "sam" });
    await workflow.advance(release.id, {
      type: "DEPLOY_SUCCEEDED",
      actor: "deploy-bot",
      payload: { deploymentId: "dep-1" },
    });
    await workflow.advance(release.id, { type: "SANITY_PASSED", actor: "test-bot", payload: {} });

    expect(jira.addComment).toHaveBeenCalledWith(expect.objectContaining({ issueKey: "PCM-99" }));
  });

  it("supports the independent retry path: TICKET_CREATE_FAILED -> RETRY_TICKET_CREATE re-fires creation", async () => {
    const jira = makeFakeJira();
    jira.createIssue
      .mockRejectedValueOnce(new Error("Jira down"))
      .mockResolvedValueOnce({ key: "PCM-100", url: "https://ipsycorp.atlassian.net/browse/PCM-100", raw: "{}" });
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")), { jira, jiraProjectKey: "PCM" });
    const workflow = new WorkflowExecutor(engine, loadWorkflowConfig("config/pipeline.yaml"));

    const release = engine.createRelease({
      version: "1.0.0",
      repos: [{ name: "web", sourceBranch: "main" }],
      environment: "prod",
      createdBy: "sam",
      bump: "minor",
      plannedStart: "2026-10-02 10:00",
      plannedEnd: "2026-10-02 11:00",
      affectedServices: ["ari:cloud:graph::service/test/web"],
    });
    await workflow.advance(release.id, {
      type: "BRANCHES_CREATED",
      actor: "sam",
      payload: { branches: { web: "release/1.0.0" } },
    });
    await confirmReleasePr(workflow, release.id);

    // The action itself catches its own errors (best-effort), so the release stays in
    // TICKET_CREATE_PENDING even though the underlying Jira call failed; the operator reports
    // that explicitly via TICKET_CREATE_FAILED.
    const { release: afterFailure } = await workflow.advance(release.id, {
      type: "TICKET_CREATE_FAILED",
      actor: "sam",
    });
    expect(afterFailure.state).toBe("TICKET_CREATE_FAILED");

    const { release: afterRetry } = await workflow.advance(release.id, {
      type: "RETRY_TICKET_CREATE",
      actor: "sam",
    });
    expect(afterRetry.state).toBe("QA_APPROVAL_PENDING");
    expect(afterRetry.ticket).toEqual({
      id: "PCM-100",
      url: "https://ipsycorp.atlassian.net/browse/PCM-100",
    });
    expect(jira.createIssue).toHaveBeenCalledTimes(2);
  });
});
