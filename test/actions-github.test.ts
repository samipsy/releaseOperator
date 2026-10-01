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
  getPullRequest: ReturnType<typeof vi.fn>;
  updatePullRequest: ReturnType<typeof vi.fn>;
  tagReleaseBranch: ReturnType<typeof vi.fn>;
  listCommitsAhead: ReturnType<typeof vi.fn>;
  latestTagName: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
  readFileMeta: ReturnType<typeof vi.fn>;
  commitFile: ReturnType<typeof vi.fn>;
  listDirectory: ReturnType<typeof vi.fn>;
  listPullRequestsForCommit: ReturnType<typeof vi.fn>;
} {
  return {
    createReleaseBranch: vi.fn().mockResolvedValue({ ref: "refs/heads/release/1.0.0", sha: "abc123", raw: "{}" }),
    createBackmergePullRequest: vi
      .fn()
      .mockResolvedValue({ url: "https://github.com/ipsy/web/pull/1", number: 1, raw: "{}" }),
    getPullRequest: vi.fn().mockResolvedValue({
      number: 9,
      url: "https://github.com/ipsy/web/pull/9",
      body: "## Version\n\nv1.0.0\n\n## Release notes\n\nplaceholder\n",
      raw: "{}",
    }),
    updatePullRequest: vi.fn().mockResolvedValue({ url: "https://github.com/ipsy/web/pull/9", number: 9, raw: "{}" }),
    tagReleaseBranch: vi.fn().mockResolvedValue({ ref: "refs/tags/v1.0.0", sha: "abc123", raw: "{}" }),
    listCommitsAhead: vi.fn().mockResolvedValue([]),
    latestTagName: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(undefined),
    readFileMeta: vi.fn().mockResolvedValue(undefined),
    commitFile: vi.fn().mockResolvedValue({ sha: "def456", raw: "{}" }),
    listDirectory: vi.fn().mockResolvedValue([]),
    listPullRequestsForCommit: vi.fn().mockResolvedValue([]),
  };
}

async function driveToBackmergePending(engine: ReleaseEngine, workflow: WorkflowExecutor, repoOwner?: string) {
  const release = engine.createRelease({
    version: "1.0.0",
    repos: [{ name: "web", sourceBranch: "develop", targetBranch: "main", owner: repoOwner }],
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
  await workflow.advance(release.id, { type: "CHANGE_APPLIED", actor: "sam" });

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

  it("bumps app/package.json on the release branch after cutting it", async () => {
    const github = makeFakeGithub();
    github.readFileMeta.mockResolvedValue({
      path: "app/package.json",
      sha: "blobsha",
      text: '{\n  "name": "web",\n  "version": "0.9.0"\n}\n',
    });
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")), { github });
    const workflow = new WorkflowExecutor(engine, loadWorkflowConfig("config/pipeline.yaml"));

    const release = engine.createRelease({
      version: "1.0.0",
      repos: [{ name: "web", sourceBranch: "main", owner: "ipsy", packageJsonPath: "app/package.json" }],
      environment: "prod",
      createdBy: "sam",
    });
    await workflow.advance(release.id, {
      type: "BRANCHES_CREATED",
      actor: "sam",
      payload: { branches: { web: "release/1.0.0" } },
    });

    expect(github.readFileMeta).toHaveBeenCalledWith({
      owner: "ipsy",
      repo: "web",
      path: "app/package.json",
      ref: "release/1.0.0",
    });
    expect(github.commitFile).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "ipsy",
        repo: "web",
        path: "app/package.json",
        branch: "release/1.0.0",
        sha: "blobsha",
        message: "chore: bump version to 1.0.0",
        content: expect.stringContaining('"version": "1.0.0"'),
      })
    );
  });

  it("opens a release-to-main PR using the repo release template before the change ticket", async () => {
    const github = makeFakeGithub();
    github.listDirectory.mockResolvedValue([
      { name: "release.md", path: ".github/PULL_REQUEST_TEMPLATE/release.md", type: "file" },
    ]);
    github.readFile.mockResolvedValue("## Version\n\nvX.X.X\n\n## Release notes\n\nplaceholder\n");
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")), { github });
    const workflow = new WorkflowExecutor(engine, loadWorkflowConfig("config/pipeline.yaml"));

    const release = engine.createRelease({
      version: "1.0.0",
      repos: [{ name: "web", sourceBranch: "main", owner: "ipsy" }],
      environment: "prod",
      createdBy: "sam",
    });
    const { release: after } = await workflow.advance(release.id, {
      type: "BRANCHES_CREATED",
      actor: "sam",
      payload: { branches: { web: "release/1.0.0" } },
    });

    expect(after.state).toBe("TICKET_CREATE_PENDING");
    expect(after.repos[0]?.releasePrUrl).toBe("https://github.com/ipsy/web/pull/1");
    expect(github.createBackmergePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "ipsy",
        repo: "web",
        title: "Release 1.0.0",
        head: "release/1.0.0",
        base: "main",
        body: expect.stringContaining("v1.0.0"),
      })
    );
    expect(github.createBackmergePullRequest.mock.calls[0][0].body).toContain("v1.0.0");
    expect(github.createBackmergePullRequest.mock.calls[0][0].body).toContain("## Release notes");
    expect(github.createBackmergePullRequest.mock.calls[0][0].body).not.toContain("vX.X.X");
  });

  it("opens the release PR into main even when the recorded source branch is develop", async () => {
    const github = makeFakeGithub();
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")), { github });
    const workflow = new WorkflowExecutor(engine, loadWorkflowConfig("config/pipeline.yaml"));

    const release = engine.createRelease({
      version: "0.42.0",
      repos: [{ name: "web", sourceBranch: "develop", owner: "ipsy" }],
      environment: "prod",
      createdBy: "sam",
    });
    await workflow.advance(release.id, {
      type: "BRANCHES_CREATED",
      actor: "sam",
      payload: { branches: { web: "release/0.42.0" } },
    });

    expect(github.createBackmergePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        head: "release/0.42.0",
        base: "main",
      })
    );
  });

  it("uses the recorded targetBranch as the release PR base", async () => {
    const github = makeFakeGithub();
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")), { github });
    const workflow = new WorkflowExecutor(engine, loadWorkflowConfig("config/pipeline.yaml"));

    const release = engine.createRelease({
      version: "0.42.0",
      repos: [{ name: "web", sourceBranch: "develop", targetBranch: "main", owner: "ipsy" }],
      environment: "prod",
      createdBy: "sam",
    });
    await workflow.advance(release.id, {
      type: "BRANCHES_CREATED",
      actor: "sam",
      payload: { branches: { web: "release/0.42.0" } },
    });

    expect(github.createReleaseBranch).toHaveBeenCalledWith(
      expect.objectContaining({ fromBranch: "develop", branch: "release/0.42.0" })
    );
    expect(github.createBackmergePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ head: "release/0.42.0", base: "main" })
    );
  });

  it("patches the release PR body with the PCM ticket after TICKET_CREATED", async () => {
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
    await workflow.advance(release.id, {
      type: "TICKET_CREATED",
      actor: "sam",
      payload: { ticketId: "PCM-99", ticketUrl: "https://ipsycorp.atlassian.net/browse/PCM-99" },
    });

    expect(github.getPullRequest).toHaveBeenCalledWith({ owner: "ipsy", repo: "web", pullNumber: 1 });
    expect(github.updatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "ipsy",
        repo: "web",
        pullNumber: 1,
        body: expect.stringContaining("[PCM-99](https://ipsycorp.atlassian.net/browse/PCM-99)"),
      })
    );
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

    expect(after.state).toBe("RELEASE_PR_PENDING");
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

    expect(after.state).toBe("RELEASE_PR_PENDING");
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
        head: "main",
        base: "develop",
        title: expect.stringContaining("Backmerge"),
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
