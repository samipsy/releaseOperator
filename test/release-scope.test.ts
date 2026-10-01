import { describe, expect, it, vi } from "vitest";
import { backmergePrBase, backmergePrHead, releasePrBase } from "../src/github/releaseBranches.js";
import { ticketKeysFromText } from "../src/intelligence/ticketKeys.js";
import { collectReleaseTicketScope } from "../src/jira/releaseScope.js";
import type { GithubProvider } from "../src/github/types.js";
import type { JiraProvider } from "../src/jira/types.js";
import type { IntelligenceProvider } from "../src/intelligence/types.js";
import type { Release } from "../src/types.js";

describe("ticketKeysFromText", () => {
  it("extracts distinct Jira keys from commit messages", () => {
    expect(ticketKeysFromText("PCM-12 fix checkout\nAlso PCM-12 and PROJ-9")).toEqual(["PCM-12", "PROJ-9"]);
  });
});

describe("releasePrBase", () => {
  it("defaults the merge target to main when targetBranch is unset", () => {
    expect(releasePrBase({ sourceBranch: "develop" })).toBe("main");
    expect(releasePrBase({ sourceBranch: "main" })).toBe("main");
  });

  it("uses an explicit targetBranch", () => {
    expect(releasePrBase({ sourceBranch: "develop", targetBranch: "main" })).toBe("main");
    expect(releasePrBase({ sourceBranch: "main", targetBranch: "develop" })).toBe("develop");
  });
});

describe("backmerge PR direction", () => {
  it("opens target into source (the reverse of the release PR)", () => {
    const repo = { sourceBranch: "develop", targetBranch: "main" };
    expect(backmergePrHead(repo)).toBe("main");
    expect(backmergePrBase(repo)).toBe("develop");
  });
});

function release(overrides?: Partial<Release>): Release {
  const now = new Date();
  return {
    id: "rel-1",
    version: "1.2.3",
    state: "TICKET_CREATE_PENDING",
    repos: [{ name: "web", owner: "ipsy", sourceBranch: "main", releaseBranch: "release/1.2.3" }],
    environment: "prod",
    approvals: {},
    ci: { status: "unknown" },
    featureFlags: [],
    createdBy: "sam",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("collectReleaseTicketScope", () => {
  it("compares release branch to main, parses keys, and loads Jira summaries", async () => {
    const github: GithubProvider = {
      createReleaseBranch: vi.fn(),
      createBackmergePullRequest: vi.fn(),
      getPullRequest: vi.fn(),
      updatePullRequest: vi.fn(),
      tagReleaseBranch: vi.fn(),
      listCommitsAhead: vi.fn().mockResolvedValue([
        { sha: "aaa111bbb", message: "PCM-42 fix checkout null pointer" },
      ]),
      latestTagName: vi.fn(),
      readFile: vi.fn().mockResolvedValue(undefined),
      readFileMeta: vi.fn(),
      commitFile: vi.fn(),
      listDirectory: vi.fn().mockResolvedValue([]),
      listPullRequestsForCommit: vi.fn().mockResolvedValue([
        { number: 88, title: "Fix checkout null pointer", userLogin: "sam" },
      ]),
    };
    const intelligence = {
      extractTicketKeys: vi.fn().mockResolvedValue(["PCM-42"]),
      generateTicketDescription: vi.fn(),
      summarizeChanges: vi.fn(),
      generateReleaseNotes: vi.fn(),
      identifyAffectedComponents: vi.fn(),
      suggestSanityTests: vi.fn(),
      summarizeFailure: vi.fn(),
    } as unknown as IntelligenceProvider;
    const jira: JiraProvider = {
      createIssue: vi.fn(),
      addComment: vi.fn(),
      getIssue: vi.fn().mockResolvedValue({
        key: "PCM-42",
        summary: "Checkout NPE",
        description: "Cart could not complete.",
        url: "https://ipsycorp.atlassian.net/browse/PCM-42",
      }),
    };

    const scope = await collectReleaseTicketScope({ release: release(), github, jira, intelligence });
    expect(github.listCommitsAhead).toHaveBeenCalledWith({
      owner: "ipsy",
      repo: "web",
      base: "main",
      head: "release/1.2.3",
    });
    expect(intelligence.extractTicketKeys).toHaveBeenCalled();
    expect(jira.getIssue).toHaveBeenCalledWith("PCM-42");
    expect(scope.tickets[0]).toMatchObject({ key: "PCM-42", summary: "Checkout NPE" });
    expect(scope.releaseNotes).toContain("https://ipsycorp.atlassian.net/browse/PCM-42");
    expect(scope.releaseNotes).toContain("PCM&#8209;42");
    expect(scope.changes[0]?.prUrl).toBe("https://github.com/ipsy/web/pull/88");
    expect(scope.context).toContain("PCM-42");
  });

  it("falls back to latest tag when the release branch has no commits ahead of main", async () => {
    const listCommitsAhead = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ sha: "ccc", message: "PCM-7 add glow" }]);
    const github: GithubProvider = {
      createReleaseBranch: vi.fn(),
      createBackmergePullRequest: vi.fn(),
      getPullRequest: vi.fn(),
      updatePullRequest: vi.fn(),
      tagReleaseBranch: vi.fn(),
      listCommitsAhead,
      latestTagName: vi.fn().mockResolvedValue("v1.2.2"),
      readFile: vi.fn().mockResolvedValue(undefined),
      readFileMeta: vi.fn(),
      commitFile: vi.fn(),
      listDirectory: vi.fn().mockResolvedValue([]),
      listPullRequestsForCommit: vi.fn().mockResolvedValue([]),
    };
    await collectReleaseTicketScope({ release: release(), github });
    expect(listCommitsAhead).toHaveBeenNthCalledWith(2, {
      owner: "ipsy",
      repo: "web",
      base: "v1.2.2",
      head: "release/1.2.3",
    });
  });

  it("compares the release branch against main when sourceBranch is develop", async () => {
    const github: GithubProvider = {
      createReleaseBranch: vi.fn(),
      createBackmergePullRequest: vi.fn(),
      getPullRequest: vi.fn(),
      updatePullRequest: vi.fn(),
      tagReleaseBranch: vi.fn(),
      listCommitsAhead: vi.fn().mockResolvedValue([{ sha: "aaa", message: "PCM-1" }]),
      latestTagName: vi.fn(),
      readFile: vi.fn(),
      readFileMeta: vi.fn(),
      commitFile: vi.fn(),
      listDirectory: vi.fn(),
      listPullRequestsForCommit: vi.fn().mockResolvedValue([]),
    };
    await collectReleaseTicketScope({
      release: release({
        repos: [{ name: "web", owner: "ipsy", sourceBranch: "develop", releaseBranch: "release/0.42.0" }],
      }),
      github,
    });
    expect(github.listCommitsAhead).toHaveBeenCalledWith({
      owner: "ipsy",
      repo: "web",
      base: "main",
      head: "release/0.42.0",
    });
  });

  it("compares against targetBranch when it is set", async () => {
    const github: GithubProvider = {
      createReleaseBranch: vi.fn(),
      createBackmergePullRequest: vi.fn(),
      getPullRequest: vi.fn(),
      updatePullRequest: vi.fn(),
      tagReleaseBranch: vi.fn(),
      listCommitsAhead: vi.fn().mockResolvedValue([{ sha: "aaa", message: "PCM-1" }]),
      latestTagName: vi.fn(),
      readFile: vi.fn(),
      readFileMeta: vi.fn(),
      commitFile: vi.fn(),
      listDirectory: vi.fn(),
      listPullRequestsForCommit: vi.fn().mockResolvedValue([]),
    };
    await collectReleaseTicketScope({
      release: release({
        repos: [
          {
            name: "web",
            owner: "ipsy",
            sourceBranch: "develop",
            targetBranch: "main",
            releaseBranch: "release/0.42.0",
          },
        ],
      }),
      github,
    });
    expect(github.listCommitsAhead).toHaveBeenCalledWith({
      owner: "ipsy",
      repo: "web",
      base: "main",
      head: "release/0.42.0",
    });
  });
});
