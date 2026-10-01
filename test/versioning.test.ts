import { describe, expect, it, vi } from "vitest";
import { GithubServiceError } from "../src/errors.js";
import { readRepoPackageJsonVersion } from "../src/github/readPackageJson.js";
import type { CatalogRepo } from "../src/github/repoCatalog.js";
import { nextVersionFromPackage, parseReleaseBump, applyPackageJsonVersion } from "../src/versioning.js";

const WEB: CatalogRepo = {
  name: "web",
  owner: "ipsy",
  fullName: "ipsy/web",
  url: "https://github.com/ipsy/web",
};

describe("parseReleaseBump", () => {
  it("accepts major, minor, and patch", () => {
    expect(parseReleaseBump("PATCH")).toBe("patch");
    expect(parseReleaseBump(" Minor ")).toBe("minor");
    expect(parseReleaseBump("major")).toBe("major");
  });

  it("rejects other values", () => {
    expect(() => parseReleaseBump("hotfix")).toThrow(/major, minor, or patch/);
  });
});

describe("nextVersionFromPackage", () => {
  it("bumps major.minor.patch and drops a leading v / prerelease", () => {
    expect(nextVersionFromPackage("1.2.3", "patch")).toBe("1.2.4");
    expect(nextVersionFromPackage("1.2.3", "minor")).toBe("1.3.0");
    expect(nextVersionFromPackage("1.2.3", "major")).toBe("2.0.0");
    expect(nextVersionFromPackage("v0.9.0", "minor")).toBe("0.10.0");
    expect(nextVersionFromPackage("1.2.3-rc.1", "patch")).toBe("1.2.4");
  });
});

describe("readRepoPackageJsonVersion", () => {
  it("fetches package.json from GitHub Contents and ignores any localPath", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: "9.0.0" }), { status: 200 }));
    const result = await readRepoPackageJsonVersion({
      repo: { ...WEB, localPath: "/tmp/would-be-wrong" },
      branch: "develop",
      token: "tok",
      fetchImpl,
    });
    expect(result.version).toBe("9.0.0");
    expect(result.ref).toBe("ipsy/web@develop:app/package.json");
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/repos/ipsy/web/contents/app/package.json?ref=develop");
  });

  it("prefers app/package.json over a root package.json (e.g. landings-forked)", async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string | URL) => {
      const href = String(url);
      if (href.includes("/contents/app/package.json?")) {
        return Promise.resolve(new Response(JSON.stringify({ version: "4.1.0" }), { status: 200 }));
      }
      if (href.includes("/contents/package.json?")) {
        return Promise.resolve(new Response(JSON.stringify({ version: "0.0.1" }), { status: 200 }));
      }
      return Promise.resolve(new Response("nope", { status: 500 }));
    });
    const result = await readRepoPackageJsonVersion({
      repo: { name: "landings-forked", owner: "myglam", fullName: "myglam/landings-forked", url: "https://github.com/myglam/landings-forked" },
      branch: "main",
      token: "tok",
      fetchImpl,
    });
    expect(result.version).toBe("4.1.0");
    expect(result.path).toBe("app/package.json");
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).includes("/contents/package.json?"))).toBe(false);
  });

  it("falls back to root package.json when app/package.json is missing", async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string | URL) => {
      const href = String(url);
      if (href.includes("/contents/app/package.json?")) {
        return Promise.resolve(new Response("missing", { status: 404, statusText: "Not Found" }));
      }
      if (href.includes("/contents/package.json?")) {
        return Promise.resolve(new Response(JSON.stringify({ version: "9.0.0" }), { status: 200 }));
      }
      return Promise.resolve(new Response("nope", { status: 500 }));
    });
    const result = await readRepoPackageJsonVersion({
      repo: WEB,
      branch: "main",
      token: "tok",
      fetchImpl,
    });
    expect(result.version).toBe("9.0.0");
    expect(result.path).toBe("package.json");
  });

  it("uses catalog packageJsonPath without trying the repo root", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 }));
    await readRepoPackageJsonVersion({
      repo: { ...WEB, packageJsonPath: "app/package.json" },
      branch: "main",
      token: "tok",
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/contents/app/package.json?ref=main");
  });

  it("decodes GitHub Contents API base64 payloads", async () => {
    const encoded = Buffer.from(JSON.stringify({ version: "2.0.0" }), "utf8").toString("base64");
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ encoding: "base64", content: encoded }), { status: 200 })
    );
    const result = await readRepoPackageJsonVersion({ repo: WEB, branch: "main", token: "tok", fetchImpl });
    expect(result.version).toBe("2.0.0");
  });

  it("throws when GitHub returns an error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 404, statusText: "Not Found" }));
    await expect(
      readRepoPackageJsonVersion({ repo: WEB, branch: "main", token: "tok", fetchImpl })
    ).rejects.toThrow(GithubServiceError);
  });

  it("throws when the GitHub token is missing", async () => {
    const prev = process.env.RELEASE_OPERATOR_GITHUB_TOKEN;
    delete process.env.RELEASE_OPERATOR_GITHUB_TOKEN;
    try {
      await expect(readRepoPackageJsonVersion({ repo: WEB, branch: "main" })).rejects.toThrow(
        /RELEASE_OPERATOR_GITHUB_TOKEN/
      );
    } finally {
      if (prev !== undefined) process.env.RELEASE_OPERATOR_GITHUB_TOKEN = prev;
    }
  });
});

describe("applyPackageJsonVersion", () => {
  it("replaces the version field and keeps surrounding JSON", () => {
    const result = applyPackageJsonVersion('{\n  "name": "app",\n  "version": "0.41.0"\n}\n', "0.42.0");
    expect(result.changed).toBe(true);
    expect(result.previous).toBe("0.41.0");
    expect(result.text).toContain('"version": "0.42.0"');
    expect(result.text).toContain('"name": "app"');
  });

  it("is a no-op when the version is already correct", () => {
    const src = '{\n  "version": "1.0.0"\n}\n';
    expect(applyPackageJsonVersion(src, "1.0.0")).toEqual({ text: src, previous: "1.0.0", changed: false });
  });
});
