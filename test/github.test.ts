import { describe, it, expect, vi } from "vitest";
import { GithubMcpProvider } from "../src/github/githubMcpProvider.js";
import { classifyPullRequestReviews } from "../src/github/prReviews.js";
import { tickGithubPrApprovalWatch, runGithubPrApprovalWatch } from "../src/github/watchPrApprovals.js";
import { GithubServiceError } from "../src/errors.js";
import type { McpToolCaller } from "../src/mcp/types.js";

function makeCaller(response: { content: { type: string; text?: string }[]; isError?: boolean }): McpToolCaller {
  return { callTool: vi.fn().mockResolvedValue(response) };
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

describe("GithubMcpProvider - MCP-backed operations", () => {
  it("calls create_branch with the right arguments and parses ref/sha from JSON output", async () => {
    const caller = makeCaller(textResult(JSON.stringify({ ref: "refs/heads/release/1.0.0", object: { sha: "abc123" } })));
    const provider = new GithubMcpProvider({ caller, token: "tok" });

    const result = await provider.createReleaseBranch({
      owner: "ipsy",
      repo: "web",
      branch: "release/1.0.0",
      fromBranch: "main",
    });

    expect(result).toEqual({ ref: "refs/heads/release/1.0.0", sha: "abc123", raw: expect.any(String) });
    expect(caller.callTool).toHaveBeenCalledWith({
      name: "create_branch",
      arguments: { owner: "ipsy", repo: "web", branch: "release/1.0.0", from_branch: "main" },
    });
  });

  it("falls back to a constructed ref when create_branch output isn't valid JSON", async () => {
    const caller = makeCaller(textResult("Branch created successfully"));
    const provider = new GithubMcpProvider({ caller, token: "tok" });

    const result = await provider.createReleaseBranch({ owner: "ipsy", repo: "web", branch: "release/1.0.0" });

    expect(result.ref).toBe("refs/heads/release/1.0.0");
    expect(result.sha).toBeUndefined();
    expect(result.raw).toBe("Branch created successfully");
  });

  it("throws GithubServiceError when create_branch reports isError", async () => {
    const caller = makeCaller(textResult("422: Reference already exists", true));
    const provider = new GithubMcpProvider({ caller, token: "tok" });

    await expect(
      provider.createReleaseBranch({ owner: "ipsy", repo: "web", branch: "release/1.0.0" })
    ).rejects.toThrow(GithubServiceError);
    await expect(
      provider.createReleaseBranch({ owner: "ipsy", repo: "web", branch: "release/1.0.0" })
    ).rejects.toThrow(/already exists/);
  });

  it("calls create_pull_request and parses html_url/number from JSON output", async () => {
    const caller = makeCaller(
      textResult(JSON.stringify({ html_url: "https://github.com/ipsy/web/pull/42", number: 42 }))
    );
    const provider = new GithubMcpProvider({ caller, token: "tok" });

    const result = await provider.createBackmergePullRequest({
      owner: "ipsy",
      repo: "web",
      title: "Backmerge",
      head: "release/1.0.0",
      base: "main",
      body: "Automated backmerge",
    });

    expect(result).toEqual({
      url: "https://github.com/ipsy/web/pull/42",
      number: 42,
      raw: expect.any(String),
    });
    expect(caller.callTool).toHaveBeenCalledWith({
      name: "create_pull_request",
      arguments: {
        owner: "ipsy",
        repo: "web",
        title: "Backmerge",
        head: "release/1.0.0",
        base: "main",
        body: "Automated backmerge",
        draft: undefined,
      },
    });
  });
});

describe("GithubMcpProvider - get/update pull request (REST)", () => {
  it("loads and patches a pull request body", async () => {
    const caller = makeCaller(textResult("unused"));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ number: 9, html_url: "https://github.com/ipsy/web/pull/9", body: "## Version\n\nv1.0.0" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ number: 9, html_url: "https://github.com/ipsy/web/pull/9" }),
      } as Response);
    const provider = new GithubMcpProvider({ caller, token: "tok", fetchImpl });

    const loaded = await provider.getPullRequest({ owner: "ipsy", repo: "web", pullNumber: 9 });
    expect(loaded.body).toContain("v1.0.0");
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.github.com/repos/ipsy/web/pulls/9");

    await provider.updatePullRequest({
      owner: "ipsy",
      repo: "web",
      pullNumber: 9,
      body: "## Ticket\n\nPCM-99",
    });
    expect(fetchImpl.mock.calls[1][0]).toBe("https://api.github.com/repos/ipsy/web/pulls/9");
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({ method: "PATCH" });
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({ body: "## Ticket\n\nPCM-99" });
    expect(caller.callTool).not.toHaveBeenCalled();
  });

  it("merges a pull request via REST PUT", async () => {
    const caller = makeCaller(textResult("unused"));
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ merged: true, sha: "abc123" }),
    } as Response);
    const provider = new GithubMcpProvider({ caller, token: "tok", fetchImpl });
    const result = await provider.mergePullRequest({ owner: "ipsy", repo: "landings", pullNumber: 12 });
    expect(result).toEqual({ merged: true, sha: "abc123", raw: expect.any(String) });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.github.com/repos/ipsy/landings/pulls/12/merge");
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: "PUT" });
  });

  it("lists pull request reviews via REST", async () => {
    const caller = makeCaller(textResult("unused"));
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify([
          { user: { login: "alice" }, state: "COMMENTED", body: "nits" },
          { user: { login: "bob" }, state: "APPROVED", body: "" },
        ]),
    } as Response);
    const provider = new GithubMcpProvider({ caller, token: "tok", fetchImpl });
    const reviews = await provider.listPullRequestReviews({ owner: "ipsy", repo: "landings", pullNumber: 88 });
    expect(reviews).toEqual([
      { userLogin: "alice", state: "COMMENTED", body: "nits" },
      { userLogin: "bob", state: "APPROVED" },
    ]);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.github.com/repos/ipsy/landings/pulls/88/reviews");
  });

  it("commits a file via Contents PUT on a branch", async () => {
    const caller = makeCaller(textResult("unused"));
    const encoded = Buffer.from('{"version":"0.41.0"}\n', "utf8").toString("base64");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sha: "blobsha", encoding: "base64", content: encoded, path: "app/package.json" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ commit: { sha: "newsha", html_url: "https://github.com/ipsy/web/commit/newsha" } }), { status: 200 })
      );
    const provider = new GithubMcpProvider({ caller, token: "tok", fetchImpl });

    const meta = await provider.readFileMeta({
      owner: "ipsy",
      repo: "web",
      path: "app/package.json",
      ref: "release/0.42.0",
    });
    expect(meta).toEqual({
      path: "app/package.json",
      sha: "blobsha",
      text: '{"version":"0.41.0"}\n',
    });

    const committed = await provider.commitFile({
      owner: "ipsy",
      repo: "web",
      path: "app/package.json",
      branch: "release/0.42.0",
      sha: "blobsha",
      message: "chore: bump version to 0.42.0",
      content: '{"version":"0.42.0"}\n',
    });
    expect(committed.sha).toBe("newsha");
    expect(String(fetchImpl.mock.calls[1][0])).toBe(
      "https://api.github.com/repos/ipsy/web/contents/app/package.json"
    );
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({ method: "PUT" });
    const body = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body)) as {
      message: string;
      branch: string;
      sha: string;
      content: string;
    };
    expect(body).toMatchObject({
      message: "chore: bump version to 0.42.0",
      branch: "release/0.42.0",
      sha: "blobsha",
    });
    expect(Buffer.from(body.content, "base64").toString("utf8")).toBe('{"version":"0.42.0"}\n');
    expect(caller.callTool).not.toHaveBeenCalled();
  });
});

describe("GithubMcpProvider - tagReleaseBranch (direct REST fallback, no MCP)", () => {
  it("looks up the branch HEAD sha, then creates a tag ref, without touching the MCP caller", async () => {
    const caller = makeCaller(textResult("should never be called for tagging"));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ commit: { sha: "deadbeef" } }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ref: "refs/tags/v1.0.0", object: { sha: "deadbeef" } }),
      } as Response);

    const provider = new GithubMcpProvider({ caller, token: "tok", fetchImpl });

    const result = await provider.tagReleaseBranch({
      owner: "ipsy",
      repo: "web",
      branch: "release/1.0.0",
      tag: "v1.0.0",
    });

    expect(result).toEqual({ ref: "refs/tags/v1.0.0", sha: "deadbeef", raw: expect.any(String) });
    expect(caller.callTool).not.toHaveBeenCalled();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [branchUrl, branchInit] = fetchImpl.mock.calls[0];
    expect(branchUrl).toBe("https://api.github.com/repos/ipsy/web/branches/release%2F1.0.0");
    expect(branchInit.headers.Authorization).toBe("Bearer tok");
    expect(branchInit.headers["X-GitHub-Api-Version"]).toBe("2026-03-10");

    const [refUrl, refInit] = fetchImpl.mock.calls[1];
    expect(refUrl).toBe("https://api.github.com/repos/ipsy/web/git/refs");
    expect(refInit.method).toBe("POST");
    expect(JSON.parse(refInit.body)).toEqual({ ref: "refs/tags/v1.0.0", sha: "deadbeef" });
  });

  it("lists commits on head that are not on base via REST compare", async () => {
    const caller = makeCaller(textResult("unused"));
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          commits: [{ sha: "abc123def", commit: { message: "PCM-1 fix checkout" } }],
        }),
        { status: 200 }
      )
    );
    const provider = new GithubMcpProvider({ caller, token: "tok", fetchImpl });
    const commits = await provider.listCommitsAhead({
      owner: "ipsy",
      repo: "web",
      base: "main",
      head: "release/1.0.0",
    });
    expect(commits).toEqual([{ sha: "abc123def", message: "PCM-1 fix checkout" }]);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/compare/main...release%2F1.0.0");
    expect(caller.callTool).not.toHaveBeenCalled();
  });

  it("reads a file via REST and returns undefined on 404", async () => {
    const caller = makeCaller(textResult("unused"));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("## Release {{version}}", { status: 200 }))
      .mockResolvedValueOnce(new Response("missing", { status: 404, statusText: "Not Found" }));
    const provider = new GithubMcpProvider({ caller, token: "tok", fetchImpl });
    const text = await provider.readFile({
      owner: "ipsy",
      repo: "web",
      path: ".github/PULL_REQUEST_TEMPLATE/release.md",
      ref: "release/1.0.0",
    });
    expect(text).toBe("## Release {{version}}");
    const missing = await provider.readFile({
      owner: "ipsy",
      repo: "web",
      path: "nope.md",
      ref: "main",
    });
    expect(missing).toBeUndefined();
  });

  it("lists a directory via REST", async () => {
    const caller = makeCaller(textResult("unused"));
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          { name: "release.md", path: ".github/PULL_REQUEST_TEMPLATE/release.md", type: "file" },
          { name: "bug.md", path: ".github/PULL_REQUEST_TEMPLATE/bug.md", type: "file" },
        ]),
        { status: 200 }
      )
    );
    const provider = new GithubMcpProvider({ caller, token: "tok", fetchImpl });
    const entries = await provider.listDirectory({
      owner: "ipsy",
      repo: "web",
      path: ".github/PULL_REQUEST_TEMPLATE",
      ref: "main",
    });
    expect(entries).toEqual([
      { name: "release.md", path: ".github/PULL_REQUEST_TEMPLATE/release.md", type: "file" },
      { name: "bug.md", path: ".github/PULL_REQUEST_TEMPLATE/bug.md", type: "file" },
    ]);
  });

  it("lists pull requests associated with a commit via REST", async () => {
    const caller = makeCaller(textResult("unused"));
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            number: 88,
            title: "Fix checkout",
            user: { login: "sam" },
            html_url: "https://github.com/ipsy/web/pull/88",
          },
        ]),
        { status: 200 }
      )
    );
    const provider = new GithubMcpProvider({ caller, token: "tok", fetchImpl });
    const pulls = await provider.listPullRequestsForCommit({
      owner: "ipsy",
      repo: "web",
      sha: "abc123def",
    });
    expect(pulls).toEqual([
      { number: 88, title: "Fix checkout", userLogin: "sam", htmlUrl: "https://github.com/ipsy/web/pull/88" },
    ]);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/commits/abc123def/pulls");
  });

  it("throws GithubServiceError if the branch lookup fails", async () => {
    const caller = makeCaller(textResult(""));
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" } as Response);
    const provider = new GithubMcpProvider({ caller, token: "tok", fetchImpl });

    await expect(
      provider.tagReleaseBranch({ owner: "ipsy", repo: "web", branch: "release/1.0.0", tag: "v1.0.0" })
    ).rejects.toThrow(GithubServiceError);
  });

  it("throws GithubServiceError if creating the tag ref fails", async () => {
    const caller = makeCaller(textResult(""));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ commit: { sha: "deadbeef" } }) } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        statusText: "Unprocessable Entity",
        text: async () => "Reference already exists",
      } as Response);
    const provider = new GithubMcpProvider({ caller, token: "tok", fetchImpl });

    await expect(
      provider.tagReleaseBranch({ owner: "ipsy", repo: "web", branch: "release/1.0.0", tag: "v1.0.0" })
    ).rejects.toThrow(/already exists/);
  });
});

describe("classifyPullRequestReviews", () => {
  it("approves when a later review is APPROVED", () => {
    expect(
      classifyPullRequestReviews([
        { userLogin: "alice", state: "COMMENTED" },
        { userLogin: "bob", state: "APPROVED" },
      ])
    ).toEqual({ kind: "approve", userLogin: "bob" });
  });

  it("rejects when any latest review is CHANGES_REQUESTED", () => {
    expect(
      classifyPullRequestReviews([
        { userLogin: "bob", state: "APPROVED" },
        { userLogin: "carol", state: "CHANGES_REQUESTED" },
      ])
    ).toEqual({ kind: "reject", userLogin: "carol" });
  });

  it("ignores dismissed reviews so a later approve can pass", () => {
    expect(
      classifyPullRequestReviews([
        { userLogin: "bob", state: "CHANGES_REQUESTED" },
        { userLogin: "bob", state: "DISMISSED" },
        { userLogin: "dana", state: "APPROVED" },
      ])
    ).toEqual({ kind: "approve", userLogin: "dana" });
  });
});

describe("tickGithubPrApprovalWatch", () => {
  const preprodPending = {
    id: "rel-pre",
    version: "1.0.0",
    state: "PREPROD_APPROVAL_PENDING" as const,
    repos: [
      {
        name: "landings",
        sourceBranch: "develop",
        releasePrUrl: "https://github.com/myglam/landings/pull/88",
      },
    ],
    environment: "preprod" as const,
    approvals: {
      preprod: { status: "pending" as const, slackChannel: "C123", slackTs: "1710000000.000100" },
    },
    ci: { status: "unknown" as const },
    featureFlags: [],
    createdBy: "sam",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("advances when the GitHub PR is approved", async () => {
    const github = {
      listPullRequestReviews: vi.fn().mockResolvedValue([{ userLogin: "releng", state: "APPROVED" }]),
    };
    const advance = vi.fn().mockResolvedValue({
      release: { ...preprodPending, state: "COMPLETE" },
      fired: [{ event: "PREPROD_MERGE_REQUESTED", resultState: "PREPROD_MERGING" }],
    });
    const tick = await tickGithubPrApprovalWatch({
      releases: [preprodPending, { ...preprodPending, id: "rel-draft", state: "DRAFT" }],
      github,
      actor: "cli",
      advance,
    });
    expect(tick.checked).toBe(1);
    expect(tick.applied[0]).toMatchObject({
      releaseId: "rel-pre",
      eventType: "PREPROD_APPROVED",
      state: "COMPLETE",
    });
    expect(github.listPullRequestReviews).toHaveBeenCalledWith({
      owner: "myglam",
      repo: "landings",
      pullNumber: 88,
    });
  });

  it("records idle when there is no GitHub Approve yet", async () => {
    const github = {
      listPullRequestReviews: vi.fn().mockResolvedValue([]),
      getPullRequest: vi.fn().mockResolvedValue({ number: 88, merged: false, raw: "{}" }),
    };
    const advance = vi.fn();
    const tick = await tickGithubPrApprovalWatch({
      releases: [preprodPending],
      github,
      actor: "cli",
      advance,
    });
    expect(tick.applied).toEqual([]);
    expect(tick.idle[0]?.reason).toMatch(/No GitHub Approve/);
    expect(advance).not.toHaveBeenCalled();
  });

  it("advances when the PR is already merged without an Approve review", async () => {
    const github = {
      listPullRequestReviews: vi.fn().mockResolvedValue([]),
      getPullRequest: vi.fn().mockResolvedValue({ number: 88, merged: true, raw: "{}" }),
    };
    const advance = vi.fn().mockResolvedValue({
      release: { ...preprodPending, state: "PREPROD_MERGING" },
      fired: [{ event: "PREPROD_MERGE_REQUESTED", resultState: "PREPROD_MERGING" }],
    });
    const tick = await tickGithubPrApprovalWatch({
      releases: [preprodPending],
      github,
      actor: "cli",
      advance,
    });
    expect(tick.applied[0]?.eventType).toBe("PREPROD_APPROVED");
    expect(advance).toHaveBeenCalled();
  });

  it("stops after applying a targeted release id", async () => {
    const github = {
      listPullRequestReviews: vi.fn().mockResolvedValue([{ userLogin: "releng", state: "APPROVED" }]),
    };
    const advance = vi.fn().mockResolvedValue({
      release: { ...preprodPending, state: "COMPLETE" },
      fired: [],
    });
    const ac = new AbortController();
    await runGithubPrApprovalWatch({
      listReleases: () => [preprodPending],
      github,
      actor: "cli",
      advance,
      intervalMs: 5_000,
      signal: ac.signal,
      releaseId: "rel-pre",
    });
    expect(advance).toHaveBeenCalledTimes(1);
  });
});
