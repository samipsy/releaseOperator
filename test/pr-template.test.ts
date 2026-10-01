import { describe, expect, it, vi } from "vitest";
import {
  applyReleaseTicketToPrBody,
  fillReleasePrBody,
  loadReleasePrTemplate,
  pickReleaseTemplateFile,
} from "../src/github/prTemplate.js";
import type { GithubProvider } from "../src/github/types.js";

describe("pickReleaseTemplateFile", () => {
  it("prefers release.md over other markdown files", () => {
    const picked = pickReleaseTemplateFile([
      { name: "bug.md", path: ".github/PULL_REQUEST_TEMPLATE/bug.md", type: "file" },
      { name: "release.md", path: ".github/PULL_REQUEST_TEMPLATE/release.md", type: "file" },
    ]);
    expect(picked?.path).toBe(".github/PULL_REQUEST_TEMPLATE/release.md");
  });
});

describe("fillReleasePrBody", () => {
  it("substitutes {{version}} and keeps checklist items from the template", () => {
    const body = fillReleasePrBody({
      template: "## Release {{version}}\n\n- [ ] QA signed off",
      version: "2.0.0",
      environment: "prod",
      repo: "web",
      head: "release/2.0.0",
      base: "main",
    });
    expect(body).toContain("## Release 2.0.0");
    expect(body).toContain("- [ ] QA signed off");
  });

  it("fills vX.X.X and the Release notes section from computed version and change lines", () => {
    const template = [
      "## Version",
      "",
      "vX.X.X",
      "",
      "## Release notes",
      "",
      "> List all changes that are included in the release with the following format:",
      ">",
      "> [APPS-XXXX] Example of PR title by @user in #0000",
      "",
      "## Changes",
      "",
      "- [ ] Checklist item",
    ].join("\n");
    const body = fillReleasePrBody({
      template,
      version: "0.42.0",
      environment: "prod",
      repo: "web",
      head: "release/0.42.0",
      base: "main",
      releaseNotes: "| Ticket # | Title | Author | PR # |\n| --- | --- | --- | --- |\n| APPS-12 | Glow bag copy | @sam | #88 |",
    });
    expect(body).toContain("v0.42.0");
    expect(body).not.toContain("vX.X.X");
    expect(body).toContain("| APPS-12 | Glow bag copy | @sam | #88 |");
    expect(body).toContain("| Ticket # | Title | Author | PR # |");
    expect(body).not.toContain("APPS-XXXX");
    expect(body).toContain("- [ ] Checklist item");
  });

  it("appends included work when the template has none", () => {
    const body = fillReleasePrBody({
      template: "## Release {{version}}",
      version: "1.0.0",
      environment: "prod",
      repo: "web",
      head: "release/1.0.0",
      base: "main",
      includedWork: "Tickets:\n- PCM-1: Fix checkout",
    });
    expect(body).toContain("## Release 1.0.0");
    expect(body).toContain("PCM-1: Fix checkout");
  });
});

describe("applyReleaseTicketToPrBody", () => {
  it("replaces PCM-XXXX and a Ticket section with the real key", () => {
    const body = applyReleaseTicketToPrBody("## Ticket\n\nPCM-XXXX\n\n## Release notes\n\nhi", {
      id: "PCM-99",
      url: "https://ipsycorp.atlassian.net/browse/PCM-99",
    });
    expect(body).toContain("[PCM-99](https://ipsycorp.atlassian.net/browse/PCM-99)");
    expect(body).not.toContain("PCM-XXXX");
    expect(body).toContain("## Release notes");
  });

  it("inserts a Ticket section after Version when the body has no placeholder", () => {
    const body = applyReleaseTicketToPrBody("## Version\n\nv1.0.0\n\n## Release notes\n\ntable", {
      id: "PCM-99",
    });
    expect(body).toContain("## Version");
    expect(body).toContain("## Ticket\n\nPCM-99");
    expect(body).toContain("## Release notes");
  });
});

describe("loadReleasePrTemplate", () => {
  it("reads the release.md file from the template directory", async () => {
    const github: GithubProvider = {
      createReleaseBranch: vi.fn(),
      createBackmergePullRequest: vi.fn(),
      getPullRequest: vi.fn(),
      updatePullRequest: vi.fn(),
      tagReleaseBranch: vi.fn(),
      listCommitsAhead: vi.fn(),
      latestTagName: vi.fn(),
      listDirectory: vi.fn().mockResolvedValue([
        { name: "release.md", path: ".github/PULL_REQUEST_TEMPLATE/release.md", type: "file" },
      ]),
      readFile: vi.fn().mockResolvedValue("## Release {{version}}"),
      readFileMeta: vi.fn(),
      commitFile: vi.fn(),
      listPullRequestsForCommit: vi.fn().mockResolvedValue([]),
    };
    const loaded = await loadReleasePrTemplate(github, { owner: "ipsy", repo: "web", ref: "release/1.0.0" });
    expect(loaded).toEqual({
      path: ".github/PULL_REQUEST_TEMPLATE/release.md",
      text: "## Release {{version}}",
    });
  });
});
