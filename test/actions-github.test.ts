import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openDb } from "../src/db.js";
import { ReleaseStore } from "../src/store.js";
import { ReleaseEngine } from "../src/engine.js";
import { loadWorkflowConfig } from "../src/workflow/loader.js";
import { WorkflowExecutor } from "../src/workflow/executor.js";
import type { GithubProvider } from "../src/github/types.js";

function makeFakeGithub(): GithubProvider & {
  createReleaseBranch: ReturnType<typeof vi.fn>;
  createBackmergePullRequest: ReturnType<typeof vi.fn>;
  tagReleaseBranch: ReturnType<typeof vi.fn>;
} {
  return {
    createReleaseBranch: vi.fn().mockResolvedValue({ ref: "refs/heads/release/1.0.0", sha: "abc123", raw: "{}" }),
    createBackmergePullRequest: vi
      .fn()
      .mockResolvedValue({ url: "https://github.com/ipsy/web/pull/1", number: 1, raw: "{}" }),
    tagReleaseBranch: vi.fn().mockResolvedValue({ ref: "refs/tags/v1.0.0", sha: "abc123", raw: "{}" }),
  };
}

async function driveToBackmergePending(engine: ReleaseEngine, workflow: WorkflowExecutor, repoOwner?: string) {
  const release = engine.createRelease({
    version: "1.0.0",
    repos: [{ name: "web", sourceBranch: "main", owner: repoOwner }],
    environment: "prod",
    createdBy: "sam",
  });

  await workflow.advance(release.id, {
    type: "BRANCHES_CREATED",
    actor: "sam",
    payload: { branches: { web: "release/1.0.0" } },
  });
  await workflow.advance(release.id, { type: "TICKET_CREATED", actor: "sam", payload: { ticketId: "PCM-1" } });
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
  await workflow.advance(release.id, { type: "TICKET_UPDATED", actor: "jira-bot", payload: {} });

  return release.id;
}

describe("real GitHub actions wired via ReleaseEngine", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("calls github.createReleaseBranch on entering BRANCH_CREATED", async () => {
    const github = makeFakeGithub();
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")), { github });
    const workflow = new WorkflowExecutor(engine, loadWorkflowConfig("config/pipeline.yaml"));

    const release = engine.createRelease({
      version: "1.0.0",
      repos: [{ name: "web", sourceBranch: "main", owner: "ipsy" }],
      environment: "prod",
      createdBy: "sam",
    });
    await workflow.advance(release.id, {
      type: "BRANCHES_CREATED",
      actor: "sam",
      payload: { branches: { web: "release/1.0.0" } },
    });

    expect(github.createReleaseBranch).toHaveBeenCalledWith({
      owner: "ipsy",
      repo: "web",
      branch: "release/1.0.0",
      fromBranch: "main",
    });
  });

  it("falls back to defaultGithubOrg when a repo has no owner set", async () => {
    const github = makeFakeGithub();
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")), { github, defaultGithubOrg: "ipsy-org" });
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

    expect(github.createReleaseBranch).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "ipsy-org", repo: "web" })
    );
  });

  it("logs an error and does not throw when no owner is resolvable", async () => {
    const github = makeFakeGithub();
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")), { github });
    const workflow = new WorkflowExecutor(engine, loadWorkflowConfig("config/pipeline.yaml"));

    const release = engine.createRelease({
      version: "1.0.0",
      repos: [{ name: "web", sourceBranch: "main" }],
      environment: "prod",
      createdBy: "sam",
    });
    const { release: after } = await workflow.advance(release.id, {
      type: "BRANCHES_CREATED",
      actor: "sam",
      payload: { branches: { web: "release/1.0.0" } },
    });

    expect(after.state).toBe("BRANCH_CREATED");
    expect(github.createReleaseBranch).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("no owner"));
  });

  it("does not call GitHub at all when no provider is configured (existing stub behavior preserved)", async () => {
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")));
    const workflow = new WorkflowExecutor(engine, loadWorkflowConfig("config/pipeline.yaml"));

    const release = engine.createRelease({
      version: "1.0.0",
      repos: [{ name: "web", sourceBranch: "main" }],
      environment: "prod",
      createdBy: "sam",
    });
    const { release: after } = await workflow.advance(release.id, {
      type: "BRANCHES_CREATED",
      actor: "sam",
      payload: { branches: { web: "release/1.0.0" } },
    });

    expect(after.state).toBe("BRANCH_CREATED");
  });

  it("calls github.createBackmergePullRequest on entering BACKMERGE_PENDING with derived head/base", async () => {
    const github = makeFakeGithub();
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")), { github });
    const workflow = new WorkflowExecutor(engine, loadWorkflowConfig("config/pipeline.yaml"));

    await driveToBackmergePending(engine, workflow, "ipsy");

    expect(github.createBackmergePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "ipsy",
        repo: "web",
        head: "release/1.0.0",
        base: "main",
      })
    );
  });

  it("calls github.tagReleaseBranch on entering TAGGED with the reported tag name", async () => {
    const github = makeFakeGithub();
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")), { github });
    const workflow = new WorkflowExecutor(engine, loadWorkflowConfig("config/pipeline.yaml"));

    const releaseId = await driveToBackmergePending(engine, workflow, "ipsy");
    await workflow.advance(releaseId, {
      type: "BACKMERGE_CREATED",
      actor: "github-bot",
      payload: { prUrl: "https://github.com/ipsy/web/pull/1" },
    });
    await workflow.advance(releaseId, {
      type: "REPOS_TAGGED",
      actor: "github-bot",
      payload: { tags: { web: "v1.0.0" } },
    });

    expect(github.tagReleaseBranch).toHaveBeenCalledWith({
      owner: "ipsy",
      repo: "web",
      branch: "release/1.0.0",
      tag: "v1.0.0",
    });
  });
});
