import type { NetlifyDeploy, NetlifyProvider } from "./types.js";

export interface WatchBranchDeploysInput {
  sites: { region: string; site: string }[];
  branch: string;
  netlify: NetlifyProvider;
  startedAt: Date;
  /** Accept ready deploys created up to this long before startedAt (default 30m). */
  lookbackMs?: number;
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export type WatchBranchDeploysResult =
  | { ok: true; deploys: { region: string; site: string; deploy: NetlifyDeploy }[] }
  | { ok: false; reason: string; pending?: boolean };

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const DEFAULT_LOOKBACK_MS = 30 * 60 * 1000;

function isReady(deploy: NetlifyDeploy | undefined, startedAt: Date, lookbackMs: number): boolean {
  if (!deploy) return false;
  if (deploy.state && deploy.state !== "ready") return false;
  if (deploy.createdAt && deploy.createdAt.getTime() < startedAt.getTime() - lookbackMs) return false;
  return deploy.state === "ready" || !deploy.state;
}

function isFailed(deploy: NetlifyDeploy | undefined): boolean {
  return deploy?.state === "error";
}

/** One Netlify poll — used by `github watch` so the CLI does not block. */
export async function checkBranchDeploys(input: {
  sites: { region: string; site: string }[];
  branch: string;
  netlify: NetlifyProvider;
  startedAt: Date;
  lookbackMs?: number;
}): Promise<WatchBranchDeploysResult> {
  const lookbackMs = input.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const deploys: { region: string; site: string; deploy: NetlifyDeploy }[] = [];
  let pending = false;
  for (const row of input.sites) {
    const deploy = await input.netlify.latestDeployForBranch(row.site, input.branch);
    if (isFailed(deploy)) {
      return {
        ok: false,
        reason: `${row.region} (${row.site}) deploy ${deploy?.id ?? "?"} state=${deploy?.state}`,
      };
    }
    if (!isReady(deploy, input.startedAt, lookbackMs) || !deploy) {
      pending = true;
      continue;
    }
    deploys.push({ region: row.region, site: row.site, deploy });
  }
  if (pending || deploys.length !== input.sites.length) {
    return { ok: false, reason: `waiting for ready deploys on ${input.branch}`, pending: true };
  }
  return { ok: true, deploys };
}

/** Poll Netlify until each site has a ready deploy on `branch` near/after startedAt. */
export async function watchBranchDeploys(input: WatchBranchDeploysInput): Promise<WatchBranchDeploysResult> {
  const timeoutMs = input.timeoutMs ?? 12 * 60 * 1000;
  const intervalMs = input.intervalMs ?? 15_000;
  const sleep = input.sleep ?? defaultSleep;
  const now = input.now ?? (() => new Date());
  const deadline = now().getTime() + timeoutMs;

  while (now().getTime() <= deadline) {
    const result = await checkBranchDeploys(input);
    if (result.ok) return result;
    if (!result.pending) return result;
    if (now().getTime() + intervalMs > deadline) break;
    await sleep(intervalMs);
  }
  return { ok: false, reason: `timed out waiting for ready deploys on ${input.branch}` };
}
