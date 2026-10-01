import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openDb } from "../src/db.js";
import { ReleaseStore } from "../src/store.js";
import { ReleaseEngine } from "../src/engine.js";
import { loadWorkflowConfig } from "../src/workflow/loader.js";
import { WorkflowExecutor } from "../src/workflow/executor.js";
import type { GithubProvider } from "../src/github/types.js";
import type { SlackProvider } from "../src/slack/types.js";
import type { NetlifyProvider } from "../src/netlify/types.js";

function makeGithub(): GithubProvider {
  return {
    createReleaseBranch: vi.fn(),
    createBackmergePullRequest: vi.fn().mockResolvedValue({
      url: "https://github.com/myglam/landings/pull/88",
      number: 88,
      raw: "{}",
    }),
    getPullRequest: vi.fn(),
    updatePullRequest: vi.fn(),
    tagReleaseBranch: vi.fn(),
    listCommitsAhead: vi.fn().mockResolvedValue([]),
    latestTagName: vi.fn(),
    readFile: vi.fn(),
    readFileMeta: vi.fn(),
    commitFile: vi.fn(),
    listDirectory: vi.fn().mockResolvedValue([]),
    listPullRequestsForCommit: vi.fn().mockResolvedValue([]),
    mergePullRequest: vi.fn().mockResolvedValue({ merged: true, sha: "merge-sha", raw: "{}" }),
  };
}

function makeSlack(): SlackProvider {
  return {
    postMessage: vi.fn().mockResolvedValue({
      ts: "1710000000.000200",
      channel: "C123",
      url: "https://slack.com/archives/C123/p1710000000000200",
    }),
    listThreadReplies: vi.fn().mockResolvedValue([]),
    getUser: vi.fn(),
    authTest: vi.fn(),
  };
}

function makeNetlify(): NetlifyProvider {
  const now = new Date();
  return {
    latestMainDeploy: vi.fn(),
    latestDeployForBranch: vi.fn().mockResolvedValue({
      id: "dep-1",
      state: "ready",
      branch: "pre-prod-1",
      createdAt: now,
      adminUrl: "https://app.netlify.com/projects/landings-ipsy/deploys/dep-1",
    }),
  };
}

describe("preprod sync workflow", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("opens the develop → pre-prod-1 PR and waits for Slack approval", async () => {
    const github = makeGithub();
    const slack = makeSlack();
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")), {
      github,
      slack,
      slackChannel: "C123",
      defaultGithubOrg: "myglam",
    });
    const workflow = new WorkflowExecutor(engine, loadWorkflowConfig("config/preprod-sync.yaml"));
    const release = engine.createRelease({
      version: "preprod-test",
      repos: [
        {
          name: "landings",
          owner: "myglam",
          url: "https://github.com/myglam/landings",
          sourceBranch: "develop",
          targetBranch: "pre-prod-1",
        },
      ],
      environment: "preprod",
      createdBy: "sam",
    });

    const { release: after } = await workflow.advance(release.id, {
      type: "PREPROD_PR_REQUESTED",
      actor: "sam",
    });

    expect(after.state).toBe("PREPROD_APPROVAL_PENDING");
    expect(github.createBackmergePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "myglam",
        repo: "landings",
        head: "develop",
        base: "pre-prod-1",
        title: "Sync develop → pre-prod-1",
      })
    );
    expect(after.repos[0]?.releasePrUrl).toBe("https://github.com/myglam/landings/pull/88");
    expect(slack.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Hey team, Please review this PR to sync pre-prod-1 branch from develop: https://github.com/myglam/landings/pull/88. Thanks.",
      })
    );
  });

  it("merges after Slack approval and completes when Netlify is ready", async () => {
    const github = makeGithub();
    const slack = makeSlack();
    const netlify = makeNetlify();
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")), {
      github,
      slack,
      slackChannel: "C123",
      netlify,
      netlifyPoll: { timeoutMs: 1000, intervalMs: 1, sleep: async () => undefined },
      defaultGithubOrg: "myglam",
    });
    const workflow = new WorkflowExecutor(engine, loadWorkflowConfig("config/preprod-sync.yaml"));
    const release = engine.createRelease({
      version: "preprod-test",
      repos: [
        {
          name: "landings",
          owner: "myglam",
          url: "https://github.com/myglam/landings",
          sourceBranch: "develop",
          targetBranch: "pre-prod-1",
        },
      ],
      environment: "preprod",
      createdBy: "sam",
    });
    await workflow.advance(release.id, { type: "PREPROD_PR_REQUESTED", actor: "sam" });
    const { release: after } = await workflow.advance(release.id, {
      type: "PREPROD_APPROVED",
      actor: "sam",
      payload: { approvedBy: "lead" },
    });

    expect(github.mergePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "myglam", repo: "landings", pullNumber: 88 })
    );
    expect(netlify.latestDeployForBranch).toHaveBeenCalledWith("landings.ipsy.com", "pre-prod-1");
    expect(netlify.latestDeployForBranch).toHaveBeenCalledWith("landings.ipsy.mx", "pre-prod-1");
    expect(after.state).toBe("COMPLETE");
    expect(after.deployment?.status).toBe("success");
    expect(slack.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadTs: "1710000000.000200",
        text: expect.stringContaining("PR is now merged"),
      })
    );
    expect(slack.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadTs: "1710000000.000200",
        text: expect.stringContaining("build was successful"),
      })
    );
  });

  it("rejects prod branch events on a preprod-sync record", async () => {
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")));
    const release = engine.createRelease({
      version: "preprod-test",
      repos: [{ name: "landings", sourceBranch: "develop" }],
      environment: "preprod",
      createdBy: "sam",
    });
    await expect(
      engine.transition(release.id, { type: "BRANCHES_CREATED", actor: "sam", payload: { branches: { landings: "x" } } })
    ).rejects.toThrow(/preprod-sync/);
  });
});
