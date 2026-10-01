import { describe, expect, it, vi } from "vitest";
import { resolveCreatePrompts } from "../src/cli/promptCreate.js";
import { DEFAULT_RELEASE_MERGE_BASE, DEFAULT_RELEASE_SOURCE_BRANCH } from "../src/github/releaseBranches.js";

describe("resolveCreatePrompts", () => {
  it("uses develop/main defaults without prompting when bump and repo are given and stdin is not a TTY", async () => {
    const ask = vi.fn();
    const result = await resolveCreatePrompts({
      bump: "patch",
      repo: "web",
      stdinIsTty: false,
      ask,
    });
    expect(result).toEqual({
      bump: "patch",
      repo: "web",
      sourceBranch: DEFAULT_RELEASE_SOURCE_BRANCH,
      targetBranch: DEFAULT_RELEASE_MERGE_BASE,
      affectedServices: [],
    });
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks for source and target on a TTY even when bump and repo are already provided", async () => {
    const ask = vi.fn()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("2026-10-02 10:00")
      .mockResolvedValueOnce("2026-10-02 11:00");
    const result = await resolveCreatePrompts({
      bump: "minor",
      repo: "experience",
      stdinIsTty: true,
      ask,
    });
    expect(ask.mock.calls.map((c) => c[0])).toEqual([
      "Source branch (cut from) [develop]: ",
      "Target branch (PR merges into) [main]: ",
      "Planned start (e.g. 2026-10-02 20:00 Chicago): ",
      "Planned end (e.g. 2026-10-02 21:00 Chicago): ",
    ]);
    expect(result.sourceBranch).toBe("develop");
    expect(result.targetBranch).toBe("main");
    expect(result.plannedStart).toBe("2026-10-02 10:00");
    expect(result.plannedEnd).toBe("2026-10-02 11:00");
    expect(result.affectedServices).toEqual([]);
  });

  it("keeps typed source and target answers", async () => {
    const ask = vi.fn()
      .mockResolvedValueOnce("release-candidate")
      .mockResolvedValueOnce("main")
      .mockResolvedValueOnce("2026-10-02 10:00")
      .mockResolvedValueOnce("2026-10-02 11:00");
    const result = await resolveCreatePrompts({
      bump: "patch",
      repo: "web",
      stdinIsTty: true,
      ask,
    });
    expect(result.sourceBranch).toBe("release-candidate");
    expect(result.targetBranch).toBe("main");
  });

  it("does not ask for branches when --source and --target are passed", async () => {
    const ask = vi.fn();
    const result = await resolveCreatePrompts({
      bump: "patch",
      repo: "web",
      source: "develop",
      target: "main",
      plannedStart: "2026-10-02 10:00",
      plannedEnd: "2026-10-02 11:00",
      affectedServices: "web",
      stdinIsTty: true,
      ask,
    });
    expect(ask).not.toHaveBeenCalled();
    expect(result.sourceBranch).toBe("develop");
    expect(result.targetBranch).toBe("main");
  });
});
