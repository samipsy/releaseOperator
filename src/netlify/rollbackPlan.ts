import type { Release } from "../types.js";
import { PCM_DEFAULT_ROLLBACK_PLAN, pcmRollbackPlan } from "../jira/pcmChangeFields.js";
import { netlifyProjectsForRepos, netlifyProjectsForRepo, netlifyRepoKey, netlifyMappedRepoNames } from "./repoProjects.js";
import type { NetlifyDeploy, NetlifyProvider } from "./types.js";

function fallbackSiteUrl(site: string): string {
  return `https://${site}`;
}

async function deployUrl(netlify: NetlifyProvider | undefined, site: string): Promise<string> {
  if (!netlify) return fallbackSiteUrl(site);
  try {
    const deploy: NetlifyDeploy | undefined = await netlify.latestMainDeploy(site);
    return deploy?.adminUrl ?? fallbackSiteUrl(site);
  } catch (err) {
    console.error(`[netlify] latestMainDeploy ${site}:`, (err as Error).message ?? err);
    return fallbackSiteUrl(site);
  }
}

/** Live US/MX Netlify deploy URLs for PCM rollback, or site homepages if lookup is skipped/fails. */
export async function resolvePcmRollbackPlan(
  release: Release,
  netlify?: NetlifyProvider
): Promise<string> {
  const projects = netlifyProjectsForRepos(release.repos.map((repo) => repo.name));
  if (projects.length === 0) return PCM_DEFAULT_ROLLBACK_PLAN;
  if (!netlify) return pcmRollbackPlan(release);

  const lines = [PCM_DEFAULT_ROLLBACK_PLAN];
  for (const pair of projects) {
    const [us, mx] = await Promise.all([deployUrl(netlify, pair.us.site), deployUrl(netlify, pair.mx.site)]);
    lines.push(`US: ${us}`);
    lines.push(`MX: ${mx}`);
  }
  return lines.join("\n");
}

export interface NetlifyDeployLookup {
  region: "US" | "MX";
  site: string;
  ok: boolean;
  deploy?: NetlifyDeploy;
  error?: string;
}

/** Direct lookup for `netlify deploys` — does not swallow API errors. */
export async function lookupNetlifyDeploysForRepo(
  repoName: string,
  netlify: NetlifyProvider
): Promise<{ repo: string; key: string; sites: NetlifyDeployLookup[] }> {
  const key = netlifyRepoKey(repoName);
  const projects = netlifyProjectsForRepo(repoName);
  if (!projects) {
    throw new Error(
      `No Netlify projects mapped for "${repoName}". Known: ${netlifyMappedRepoNames().join(", ")}.`
    );
  }
  const sites: NetlifyDeployLookup[] = [];
  for (const ref of [projects.us, projects.mx]) {
    try {
      const deploy = await netlify.latestMainDeploy(ref.site);
      if (!deploy) {
        sites.push({ region: ref.region, site: ref.site, ok: false, error: "no ready production deploy on main" });
        continue;
      }
      sites.push({ region: ref.region, site: ref.site, ok: true, deploy });
    } catch (err) {
      sites.push({ region: ref.region, site: ref.site, ok: false, error: (err as Error).message });
    }
  }
  return { repo: repoName, key, sites };
}
