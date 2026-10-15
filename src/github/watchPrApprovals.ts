import type { Release, ReleaseEvent } from "../types.js";
import type { AdvanceResult } from "../workflow/executor.js";
import { resolveGithubPrApprovalEvent } from "./ingestPrApprovals.js";
import type { GithubProvider } from "./types.js";
import { resolvePreprodDeployEvent } from "../netlify/ingestPreprodDeploy.js";
import type { NetlifyProvider } from "../netlify/types.js";

export const DEFAULT_GITHUB_WATCH_INTERVAL_MS = 60_000;

export interface GithubWatchApplied {
  releaseId: string;
  eventType: ReleaseEvent["type"];
  fired: AdvanceResult["fired"];
  state: Release["state"];
  deployLines?: string[];
}

export interface GithubWatchTickResult {
  checked: number;
  applied: GithubWatchApplied[];
  idle: { releaseId: string; reason: string }[];
  errors: { releaseId: string; message: string }[];
}

function isWatchablePreprod(release: Release): boolean {
  return release.state === "PREPROD_APPROVAL_PENDING" || release.state === "PREPROD_DEPLOYING";
}

export async function tickGithubPrApprovalWatch(options: {
  releases: Release[];
  github: GithubProvider;
  netlify?: NetlifyProvider;
  actor: string;
  advance: (releaseId: string, event: ReleaseEvent) => Promise<AdvanceResult>;
  releaseId?: string;
}): Promise<GithubWatchTickResult> {
  const candidates = options.releases.filter((release) => {
    if (options.releaseId && release.id !== options.releaseId) return false;
    return isWatchablePreprod(release);
  });

  const result: GithubWatchTickResult = { checked: candidates.length, applied: [], idle: [], errors: [] };

  for (const release of candidates) {
    try {
      const ingest =
        release.state === "PREPROD_DEPLOYING"
          ? options.netlify
            ? await resolvePreprodDeployEvent({
                release,
                netlify: options.netlify,
                actor: options.actor,
              })
            : {
                status: "noop" as const,
                reason: "Netlify is not configured — cannot poll pre-prod deploys",
                replies: [],
              }
          : await resolveGithubPrApprovalEvent({
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
        ...("deployLines" in ingest && ingest.deployLines ? { deployLines: ingest.deployLines } : {}),
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

/**
 * Polls GitHub PR reviews (approve → merge) and Netlify pre-prod deploys until aborted.
 * CLI event commands must not block on Netlify — this process owns that loop.
 */
export async function runGithubPrApprovalWatch(options: {
  listReleases: () => Release[];
  github: GithubProvider;
  netlify?: NetlifyProvider;
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
      netlify: options.netlify,
      actor: options.actor,
      advance: options.advance,
      releaseId: options.releaseId,
    });
    options.onTick?.(tick);
    if (options.releaseId) {
      const applied = tick.applied.find((item) => item.releaseId === options.releaseId);
      if (
        applied &&
        applied.state !== "PREPROD_APPROVAL_PENDING" &&
        applied.state !== "PREPROD_DEPLOYING"
      ) {
        return;
      }
    }
    await delay(options.intervalMs, options.signal);
  }
}
