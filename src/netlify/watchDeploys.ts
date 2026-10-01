import type { NetlifyDeploy, NetlifyProvider } from "./types.js";

export interface WatchBranchDeploysInput {
  sites: { region: string; site: string }[];
  branch: string;
  netlify: NetlifyProvider;
  startedAt: Date;
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export type WatchBranchDeploysResult =
  | { ok: true; deploys: { region: string; site: string; deploy: NetlifyDeploy }[] }
  | { ok: false; reason: string };

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isReady(deploy: NetlifyDeploy | undefined, startedAt: Date): boolean {
  if (!deploy) return false;
  if (deploy.state && deploy.state !== "ready") return false;
  if (deploy.createdAt && deploy.createdAt.getTime() < startedAt.getTime() - 5000) return false;
  return deploy.state === "ready" || !deploy.state;
}

function isFailed(deploy: NetlifyDeploy | undefined): boolean {
  return deploy?.state === "error";
}

/** Poll Netlify until each site has a ready deploy on `branch` at or after startedAt. */
export async function watchBranchDeploys(input: WatchBranchDeploysInput): Promise<WatchBranchDeploysResult> {
  const timeoutMs = input.timeoutMs ?? 12 * 60 * 1000;
  const intervalMs = input.intervalMs ?? 15_000;
  const sleep = input.sleep ?? defaultSleep;
  const now = input.now ?? (() => new Date());
  const deadline = now().getTime() + timeoutMs;

  while (now().getTime() <= deadline) {
    const deploys: { region: string; site: string; deploy: NetlifyDeploy }[] = [];
    let failed: string | undefined;
    let pending = false;
    for (const row of input.sites) {
      const deploy = await input.netlify.latestDeployForBranch(row.site, input.branch);
      if (isFailed(deploy)) {
        failed = `${row.region} (${row.site}) deploy ${deploy?.id ?? "?"} state=${deploy?.state}`;
        break;
      }
      if (!isReady(deploy, input.startedAt) || !deploy) {
        pending = true;
        continue;
      }
      deploys.push({ region: row.region, site: row.site, deploy });
    }
    if (failed) return { ok: false, reason: failed };
    if (!pending && deploys.length === input.sites.length) return { ok: true, deploys };
    if (now().getTime() + intervalMs > deadline) break;
    await sleep(intervalMs);
  }
  return { ok: false, reason: `timed out waiting for ready deploys on ${input.branch}` };
}
