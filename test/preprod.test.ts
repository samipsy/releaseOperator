import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openDb } from "../src/db.js";
import { ReleaseStore } from "../src/store.js";
import { ReleaseEngine } from "../src/engine.js";
import { loadWorkflowConfig } from "../src/workflow/loader.js";
import { WorkflowExecutor } from "../src/workflow/executor.js";
import { tickGithubPrApprovalWatch } from "../src/github/watchPrApprovals.js";
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
    getPullRequest: vi.fn().mockResolvedValue({
      number: 88,
      url: "https://github.com/myglam/landings/pull/88",
      merged: false,
      raw: "{}",
    }),
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
    triggerBranchBuild: vi.fn().mockResolvedValue({ id: "bld-1", deployId: "dep-new" }),
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
      slackChannelPrReview: "C-PREPROD",
      slackChannelPcmApproval: "C-PCM",
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
        title: "chore(MET-1111): Sync develop -> pre-prod-1",
        body: "Pre-prod sync for `landings`.",
      })
    );
    expect(after.repos[0]?.releasePrUrl).toBe("https://github.com/myglam/landings/pull/88");
    expect(slack.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C-PREPROD",
        text: expect.stringContaining("https://github.com/myglam/landings/pull/88"),
      })
    );
    expect(slack.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Review changes → Approve"),
      })
    );
  });

  it("merges after GitHub PR approval; Netlify completion is left for watch:github", async () => {
    const github = makeGithub();
    const slack = makeSlack();
    const netlify = makeNetlify();
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")), {
      github,
      slack,
      slackChannelPrReview: "C123",
      netlify,
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
    const { release: afterMerge } = await workflow.advance(release.id, {
      type: "PREPROD_APPROVED",
      actor: "sam",
      payload: { approvedBy: "lead" },
    });

    expect(github.mergePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "myglam", repo: "landings", pullNumber: 88 })
    );
    expect(afterMerge.state).toBe("PREPROD_DEPLOYING");
    expect(netlify.triggerBranchBuild).toHaveBeenCalledWith("landings.ipsy.com", "develop");
    expect(netlify.triggerBranchBuild).toHaveBeenCalledWith("landings.ipsy.mx", "develop");
    expect(netlify.latestDeployForBranch).not.toHaveBeenCalled();
    expect(slack.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadTs: "1710000000.000200",
        text: expect.stringContaining("PR is now merged"),
      })
    );

    const tick = await tickGithubPrApprovalWatch({
      releases: [engine.getRelease(release.id)],
      github,
      netlify,
      actor: "watcher",
      advance: (id, event) => workflow.advance(id, event),
    });
    expect(tick.applied[0]?.eventType).toBe("PREPROD_DEPLOY_SUCCEEDED");
    expect(engine.getRelease(release.id).state).toBe("COMPLETE");
    expect(engine.getRelease(release.id).deployment?.status).toBe("success");
    expect(slack.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadTs: "1710000000.000200",
        text: expect.stringContaining("Build was successful"),
      })
    );
  });

  it("still reaches PREPROD_DEPLOYING if the develop HEAD build trigger fails", async () => {
    const github = makeGithub();
    const slack = makeSlack();
    const netlify = makeNetlify();
    vi.mocked(netlify.triggerBranchBuild).mockRejectedValue(new Error("Netlify 422"));
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")), {
      github,
      slack,
      slackChannelPrReview: "C123",
      netlify,
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
    const { release: afterMerge } = await workflow.advance(release.id, {
      type: "PREPROD_APPROVED",
      actor: "sam",
      payload: { approvedBy: "lead" },
    });
    expect(afterMerge.state).toBe("PREPROD_DEPLOYING");
    expect(netlify.triggerBranchBuild).toHaveBeenCalled();
  });

  it("does not retrigger develop HEAD on RETRY_PREPROD_DEPLOY when those builds already succeeded", async () => {
    const github = makeGithub();
    const slack = makeSlack();
    const netlify = makeNetlify();
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")), {
      github,
      slack,
      slackChannelPrReview: "C123",
      netlify,
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
    await workflow.advance(release.id, {
      type: "PREPROD_APPROVED",
      actor: "sam",
      payload: { approvedBy: "lead" },
    });
    expect(netlify.triggerBranchBuild).toHaveBeenCalledTimes(2);

    await workflow.advance(release.id, { type: "PREPROD_DEPLOY_FAILED", actor: "sam" });
    const { release: afterRetry } = await workflow.advance(release.id, {
      type: "RETRY_PREPROD_DEPLOY",
      actor: "sam",
    });

    expect(afterRetry.state).toBe("PREPROD_DEPLOYING");
    expect(netlify.triggerBranchBuild).toHaveBeenCalledTimes(2);
    expect(afterRetry.deployment?.sourceBranchBuilds?.["landings.ipsy.com"]?.id).toBe("bld-1");
  });

  it("retriggers develop HEAD on retry only for sites that failed the first trigger", async () => {
    const github = makeGithub();
    const slack = makeSlack();
    const netlify = makeNetlify();
    vi.mocked(netlify.triggerBranchBuild).mockImplementation(async (site: string) => {
      if (site.endsWith(".mx")) throw new Error("Netlify MX 422");
      return { id: "bld-us", deployId: "dep-us" };
    });
    const engine = new ReleaseEngine(new ReleaseStore(openDb(":memory:")), {
      github,
      slack,
      slackChannelPrReview: "C123",
      netlify,
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
    await workflow.advance(release.id, {
      type: "PREPROD_APPROVED",
      actor: "sam",
      payload: { approvedBy: "lead" },
    });
    expect(netlify.triggerBranchBuild).toHaveBeenCalledTimes(2);

    vi.mocked(netlify.triggerBranchBuild).mockResolvedValue({ id: "bld-mx", deployId: "dep-mx" });
    await workflow.advance(release.id, { type: "PREPROD_DEPLOY_FAILED", actor: "sam" });
    await workflow.advance(release.id, { type: "RETRY_PREPROD_DEPLOY", actor: "sam" });

    expect(netlify.triggerBranchBuild).toHaveBeenCalledTimes(3);
    expect(vi.mocked(netlify.triggerBranchBuild).mock.calls[2]).toEqual(["landings.ipsy.mx", "develop"]);
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
