import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_GITHUB_WATCH_LOCK_PATH = "./.github-watch.lock";

export interface GithubWatchLock {
  pid: number;
  startedAt: string;
  intervalMs: number;
  releaseId?: string;
}

export type GithubWatchLockStatus =
  | { running: false; path: string; stale?: GithubWatchLock }
  | { running: true; path: string; lock: GithubWatchLock };

export function githubWatchLockPath(): string {
  return resolve(process.env.RELEASE_OPERATOR_GITHUB_WATCH_LOCK ?? DEFAULT_GITHUB_WATCH_LOCK_PATH);
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseLock(raw: string): GithubWatchLock | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid)) return undefined;
    if (typeof parsed.startedAt !== "string" || parsed.startedAt.length === 0) return undefined;
    if (typeof parsed.intervalMs !== "number") return undefined;
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      intervalMs: parsed.intervalMs,
      ...(typeof parsed.releaseId === "string" && parsed.releaseId.length > 0
        ? { releaseId: parsed.releaseId }
        : {}),
    };
  } catch {
    return undefined;
  }
}

export function readGithubWatchLockStatus(options?: {
  path?: string;
  isAlive?: (pid: number) => boolean;
}): GithubWatchLockStatus {
  const path = options?.path ?? githubWatchLockPath();
  const isAlive = options?.isAlive ?? processIsAlive;
  if (!existsSync(path)) return { running: false, path };
  const lock = parseLock(readFileSync(path, "utf8"));
  if (!lock) return { running: false, path };
  if (!isAlive(lock.pid)) return { running: false, path, stale: lock };
  return { running: true, path, lock };
}

export function acquireGithubWatchLock(input: {
  pid: number;
  intervalMs: number;
  releaseId?: string;
  path?: string;
  isAlive?: (pid: number) => boolean;
  now?: () => Date;
}): { ok: true; path: string; lock: GithubWatchLock } | { ok: false; path: string; lock: GithubWatchLock } {
  const path = input.path ?? githubWatchLockPath();
  const status = readGithubWatchLockStatus({ path, isAlive: input.isAlive });
  if (status.running && status.lock.pid !== input.pid) {
    return { ok: false, path, lock: status.lock };
  }
  const lock: GithubWatchLock = {
    pid: input.pid,
    startedAt: (input.now ?? (() => new Date()))().toISOString(),
    intervalMs: input.intervalMs,
    ...(input.releaseId ? { releaseId: input.releaseId } : {}),
  };
  writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  return { ok: true, path, lock };
}

export function releaseGithubWatchLock(options?: { pid?: number; path?: string }): void {
  const path = options?.path ?? githubWatchLockPath();
  if (!existsSync(path)) return;
  const lock = parseLock(readFileSync(path, "utf8"));
  if (options?.pid !== undefined && lock && lock.pid !== options.pid) return;
  unlinkSync(path);
}
