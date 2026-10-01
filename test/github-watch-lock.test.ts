import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireGithubWatchLock,
  readGithubWatchLockStatus,
  releaseGithubWatchLock,
} from "../src/github/watchLock.js";

function tempLock(): string {
  return join(mkdtempSync(join(tmpdir(), "ro-watch-")), "github-watch.lock");
}

describe("github watch lock", () => {
  it("reports not running when the lock file is missing", () => {
    const path = tempLock();
    expect(readGithubWatchLockStatus({ path, isAlive: () => true })).toEqual({ running: false, path });
    rmSync(join(path, ".."), { recursive: true, force: true });
  });

  it("acquires a lock and reports running for a live pid", () => {
    const path = tempLock();
    const now = () => new Date("2026-10-01T21:00:00.000Z");
    const acquired = acquireGithubWatchLock({
      pid: 4242,
      intervalMs: 60_000,
      releaseId: "rel-pre",
      path,
      isAlive: () => false,
      now,
    });
    expect(acquired.ok).toBe(true);
    const status = readGithubWatchLockStatus({ path, isAlive: (pid) => pid === 4242 });
    expect(status).toEqual({
      running: true,
      path,
      lock: {
        pid: 4242,
        startedAt: "2026-10-01T21:00:00.000Z",
        intervalMs: 60_000,
        releaseId: "rel-pre",
      },
    });
    rmSync(join(path, ".."), { recursive: true, force: true });
  });

  it("refuses a second acquire while the first pid is alive", () => {
    const path = tempLock();
    acquireGithubWatchLock({
      pid: 11,
      intervalMs: 60_000,
      path,
      isAlive: () => false,
      now: () => new Date("2026-10-01T21:00:00.000Z"),
    });
    const second = acquireGithubWatchLock({
      pid: 22,
      intervalMs: 60_000,
      path,
      isAlive: (pid) => pid === 11,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.lock.pid).toBe(11);
    rmSync(join(path, ".."), { recursive: true, force: true });
  });

  it("replaces a stale lock and release only removes the matching pid", () => {
    const path = tempLock();
    acquireGithubWatchLock({
      pid: 11,
      intervalMs: 15_000,
      path,
      isAlive: () => false,
      now: () => new Date("2026-10-01T21:00:00.000Z"),
    });
    const replaced = acquireGithubWatchLock({
      pid: 22,
      intervalMs: 60_000,
      path,
      isAlive: () => false,
      now: () => new Date("2026-10-01T21:05:00.000Z"),
    });
    expect(replaced.ok).toBe(true);
    releaseGithubWatchLock({ pid: 11, path });
    expect(readGithubWatchLockStatus({ path, isAlive: () => true }).running).toBe(true);
    releaseGithubWatchLock({ pid: 22, path });
    expect(readGithubWatchLockStatus({ path, isAlive: () => true }).running).toBe(false);
    rmSync(join(path, ".."), { recursive: true, force: true });
  });
});
