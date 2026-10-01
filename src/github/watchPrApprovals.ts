import type { Release, ReleaseEvent } from "../types.js";
import type { AdvanceResult } from "../workflow/executor.js";
import { resolveGithubPrApprovalEvent } from "./ingestPrApprovals.js";
import type { GithubProvider } from "./types.js";

export const DEFAULT_GITHUB_WATCH_INTERVAL_MS = 60_000;

export interface GithubWatchApplied {
  releaseId: string;
  eventType: ReleaseEvent["type"];
  fired: AdvanceResult["fired"];
  state: Release["state"];
}

export interface GithubWatchTickResult {
  checked: number;
  applied: GithubWatchApplied[];
  idle: { releaseId: string; reason: string }[];
  errors: { releaseId: string; message: string }[];
}

function isPreprodApprovalPending(release: Release): boolean {
  return release.state === "PREPROD_APPROVAL_PENDING";
}

export async function tickGithubPrApprovalWatch(options: {
  releases: Release[];
  github: GithubProvider;
  actor: string;
  advance: (releaseId: string, event: ReleaseEvent) => Promise<AdvanceResult>;
  releaseId?: string;
}): Promise<GithubWatchTickResult> {
  const candidates = options.releases.filter((release) => {
    if (options.releaseId && release.id !== options.releaseId) return false;
    return isPreprodApprovalPending(release);
  });

  const result: GithubWatchTickResult = { checked: candidates.length, applied: [], idle: [], errors: [] };

  for (const release of candidates) {
    try {
      const ingest = await resolveGithubPrApprovalEvent({
        release,
        github: options.github,
        actor: options.actor,
      });
      if (ingest.status === "noop") {
        result.idle.push({ releaseId: release.id, reason: ingest.reason });
        continue;
      }
      const after = await options.advance(release.id, ingest.event);
      result.applied.push({
        releaseId: release.id,
        eventType: ingest.event.type,
        fired: after.fired,
        state: after.release.state,
      });
    } catch (err) {
      result.errors.push({ releaseId: release.id, message: (err as Error).message });
    }
  }

  return result;
}

export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Polls GitHub PR reviews for pre-prod sync until aborted. Does not read Slack. */
export async function runGithubPrApprovalWatch(options: {
  listReleases: () => Release[];
  github: GithubProvider;
  actor: string;
  advance: (releaseId: string, event: ReleaseEvent) => Promise<AdvanceResult>;
  intervalMs: number;
  signal: AbortSignal;
  releaseId?: string;
  onTick?: (tick: GithubWatchTickResult) => void;
}): Promise<void> {
  while (!options.signal.aborted) {
    const tick = await tickGithubPrApprovalWatch({
      releases: options.listReleases(),
      github: options.github,
      actor: options.actor,
      advance: options.advance,
      releaseId: options.releaseId,
    });
    options.onTick?.(tick);
    if (options.releaseId && tick.applied.some((item) => item.releaseId === options.releaseId)) {
      return;
    }
    await delay(options.intervalMs, options.signal);
  }
}
