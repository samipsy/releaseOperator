import { describe, it, expect, vi } from "vitest";
import { GithubMcpProvider } from "../src/github/githubMcpProvider.js";
import { GithubServiceError } from "../src/errors.js";
import type { McpToolCaller } from "../src/github/types.js";

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
