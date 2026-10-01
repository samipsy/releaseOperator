import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { GithubServiceError } from "../src/errors.js";
import { listOrgRepositories } from "../src/github/listOrgRepos.js";
import { lookupCatalogRepo, mergeSyncedCatalog, readRepoCatalog, upsertManualCatalogRepo, writeRepoCatalog, type RepoCatalog } from "../src/github/repoCatalog.js";
import { catalogRepoFromUrl, catalogRepoFromWorkspaceDir } from "../src/github/catalogFromDir.js";
import { parseReposSpec, resolveReposAgainstCatalog } from "../src/github/resolveRepos.js";
import type { McpToolCaller } from "../src/mcp/types.js";

const SAMPLE = {
  name: "web",
  full_name: "ipsy/web",
  html_url: "https://github.com/ipsy/web",
  owner: { login: "ipsy" },
  default_branch: "develop",
};

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

describe("parseReposSpec", () => {
  it("parses name:branch, owner/name:branch, and github HTTPS URLs", () => {
    expect(parseReposSpec("web:main")).toEqual([{ name: "web", sourceBranch: "main" }]);
    expect(parseReposSpec("ipsy/api:develop")).toEqual([{ owner: "ipsy", name: "api", sourceBranch: "develop" }]);
    expect(parseReposSpec("https://github.com/ipsy/web:release")).toEqual([
      { owner: "ipsy", name: "web", sourceBranch: "release" },
    ]);
    expect(parseReposSpec("https://github.com/ipsy/web.git")).toEqual([
      { owner: "ipsy", name: "web", sourceBranch: "main" },
    ]);
    expect(parseReposSpec("https://github.com/myglam/experience/blob/main/app/package.json")).toEqual([
      { owner: "myglam", name: "experience", sourceBranch: "main" },
    ]);
  });
});

describe("listOrgRepositories", () => {
  it("pages list_org_repositories and maps name→url", async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce(textResult(JSON.stringify([SAMPLE])))
      .mockResolvedValueOnce(textResult("[]"));
    const caller: McpToolCaller = { callTool };

    const repos = await listOrgRepositories({ org: "ipsy", caller });
    expect(repos).toEqual([{ name: "web", owner: "ipsy", fullName: "ipsy/web", url: "https://github.com/ipsy/web", defaultBranch: "develop" }]);
    expect(callTool).toHaveBeenCalledWith({
      name: "list_org_repositories",
      arguments: { org: "ipsy", perPage: 100, page: 1 },
    });
  });

  it("falls back to search_repositories when list_org_repositories is missing", async () => {
    const callTool = vi.fn().mockImplementation(({ name }: { name: string }) => {
      if (name === "list_org_repositories") {
        return Promise.resolve(textResult("unknown tool list_org_repositories", true));
      }
      return Promise.resolve(textResult(JSON.stringify({ items: [SAMPLE] })));
    });
    const repos = await listOrgRepositories({ org: "ipsy", caller: { callTool } });
    expect(repos).toHaveLength(1);
    expect(repos[0].url).toBe("https://github.com/ipsy/web");
    expect(callTool).toHaveBeenCalledWith({
      name: "search_repositories",
      arguments: { query: "org:ipsy", perPage: 100, page: 1 },
    });
  });

  it("falls back to REST when MCP tools fail and a token is provided", async () => {
    const callTool = vi.fn().mockResolvedValue(textResult("unknown tool", true));
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([SAMPLE]), { status: 200, headers: { "Content-Type": "application/json" } })
    );
    const repos = await listOrgRepositories({
      org: "ipsy",
      caller: { callTool },
      token: "tok",
      fetchImpl,
    });
    expect(repos[0].fullName).toBe("ipsy/web");
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/orgs/ipsy/repos");
  });
});

describe("resolveReposAgainstCatalog", () => {
  const catalog: RepoCatalog = {
    org: "ipsy",
    syncedAt: "2026-09-15T00:00:00.000Z",
    repos: [
      { name: "web", owner: "ipsy", fullName: "ipsy/web", url: "https://github.com/ipsy/web" },
      { name: "api", owner: "ipsy", fullName: "ipsy/api", url: "https://github.com/ipsy/api" },
    ],
  };

  it("fills owner and url from the catalog", () => {
    const resolved = resolveReposAgainstCatalog([{ name: "web", sourceBranch: "main" }], catalog);
    expect(resolved).toEqual([
      {
        name: "web",
        owner: "ipsy",
        url: "https://github.com/ipsy/web",
        fullName: "ipsy/web",
        sourceBranch: "main",
      },
    ]);
  });

  it("rejects names that are not in the catalog", () => {
    expect(() => resolveReposAgainstCatalog([{ name: "nope", sourceBranch: "main" }], catalog)).toThrow(
      GithubServiceError
    );
    expect(() => resolveReposAgainstCatalog([{ name: "nope", sourceBranch: "main" }], catalog)).toThrow(/Unknown GitHub repo/);
  });

  it("resolves a catalog alias to the GitHub repo slug", () => {
    const aliased: RepoCatalog = {
      org: "myglam",
      syncedAt: "2026-09-15T00:00:00.000Z",
      repos: [
        {
          name: "experience",
          owner: "myglam",
          fullName: "myglam/experience",
          url: "https://github.com/myglam/experience",
          source: "sync",
        },
        {
          name: "experience-main",
          owner: "myglam",
          fullName: "myglam/experience",
          url: "https://github.com/myglam/experience",
          githubRepo: "experience",
          source: "manual",
        },
      ],
    };
    const resolved = resolveReposAgainstCatalog([{ name: "experience-main", sourceBranch: "main" }], aliased);
    expect(resolved[0]).toMatchObject({
      name: "experience",
      owner: "myglam",
      fullName: "myglam/experience",
      sourceBranch: "main",
    });
  });

  it("round-trips a catalog file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ro-gh-cat-"));
    const path = join(dir, "repos.json");
    writeRepoCatalog(catalog, path);
    expect(readRepoCatalog(path)?.repos).toHaveLength(2);
    expect(lookupCatalogRepo(catalog, { name: "api" })?.url).toBe("https://github.com/ipsy/api");
  });
});

describe("manual catalog entries", () => {
  it("lets a manual test URL override the same name on sync", () => {
    const existing: RepoCatalog = {
      org: "ipsy",
      syncedAt: "2026-09-01T00:00:00.000Z",
      repos: [
        {
          name: "web",
          owner: "ipsy",
          fullName: "ipsy/web",
          url: "file:///tmp/web-clone",
          source: "manual",
          localPath: "/tmp/web-clone",
        },
      ],
    };
    const merged = mergeSyncedCatalog(
      "ipsy",
      [{ name: "web", owner: "ipsy", fullName: "ipsy/web", url: "https://github.com/ipsy/web" }],
      existing
    );
    expect(merged.repos).toHaveLength(1);
    expect(merged.repos[0].url).toBe("file:///tmp/web-clone");
    expect(merged.repos[0].source).toBe("manual");
  });

  it("upserts a GitHub URL as a manual row without wiping other repos", () => {
    const dir = mkdtempSync(join(tmpdir(), "ro-gh-cat-"));
    const path = join(dir, "repos.json");
    writeRepoCatalog(
      {
        org: "ipsy",
        syncedAt: "2026-09-15T00:00:00.000Z",
        repos: [{ name: "api", owner: "ipsy", fullName: "ipsy/api", url: "https://github.com/ipsy/api", source: "sync" }],
      },
      path
    );
    const fromUrl = catalogRepoFromUrl({ url: "https://github.com/ipsy/web.git" });
    expect(fromUrl).toMatchObject({ name: "web", owner: "ipsy", url: "https://github.com/ipsy/web", source: "manual" });
    const catalog = upsertManualCatalogRepo(fromUrl, path);
    expect(catalog.repos.map((r) => r.name).sort()).toEqual(["api", "web"]);
    expect(readRepoCatalog(path)?.repos.find((r) => r.name === "web")?.source).toBe("manual");
  });

  it("keeps a unique --name alias without replacing the GitHub repo of the same name", () => {
    const dir = mkdtempSync(join(tmpdir(), "ro-gh-cat-"));
    const path = join(dir, "repos.json");
    writeRepoCatalog(
      {
        org: "myglam",
        syncedAt: "2026-09-15T00:00:00.000Z",
        repos: [
          {
            name: "experience",
            owner: "myglam",
            fullName: "myglam/experience",
            url: "https://github.com/myglam/experience",
            source: "sync",
          },
        ],
      },
      path
    );
    const aliased = catalogRepoFromUrl({
      url: "https://github.com/myglam/experience/blob/main/app/package.json",
      name: "experience-main",
    });
    expect(aliased).toMatchObject({
      name: "experience-main",
      githubRepo: "experience",
      fullName: "myglam/experience",
    });
    const catalog = upsertManualCatalogRepo(aliased, path);
    expect(catalog.repos.map((r) => r.name).sort()).toEqual(["experience", "experience-main"]);
  });

  it("refuses to overwrite an existing catalog name unless replace is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "ro-gh-cat-"));
    const path = join(dir, "repos.json");
    writeRepoCatalog(
      {
        org: "myglam",
        syncedAt: "2026-09-15T00:00:00.000Z",
        repos: [
          {
            name: "experience",
            owner: "myglam",
            fullName: "myglam/experience",
            url: "https://github.com/myglam/experience",
            source: "sync",
          },
        ],
      },
      path
    );
    const sameName = catalogRepoFromUrl({
      url: "https://github.com/myglam/experience/blob/main/app/package.json",
    });
    expect(() => upsertManualCatalogRepo(sameName, path)).toThrow(/already has "experience"/);
    const replaced = upsertManualCatalogRepo(sameName, path, { replace: true });
    expect(replaced.repos).toHaveLength(1);
    expect(replaced.repos[0].source).toBe("manual");
  });

  it("registers a workspace directory as a file URL when git origin is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "ro-clone-"));
    const repo = catalogRepoFromWorkspaceDir(dir, { name: "fixture-app", owner: "ipsy" });
    expect(repo.source).toBe("manual");
    expect(repo.name).toBe("fixture-app");
    expect(repo.localPath).toBe(dir);
    expect(repo.url.startsWith("file://")).toBe(true);
  });

  it("parses an experience-style GitHub blob URL into branch and app/package.json", () => {
    const repo = catalogRepoFromUrl({
      url: "https://github.com/myglam/experience/blob/main/app/package.json",
    });
    expect(repo).toMatchObject({
      name: "experience",
      owner: "myglam",
      url: "https://github.com/myglam/experience",
      defaultBranch: "main",
      packageJsonPath: "app/package.json",
      source: "manual",
    });
  });
});
