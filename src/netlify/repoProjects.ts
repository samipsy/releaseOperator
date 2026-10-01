export type NetlifyRegion = "US" | "MX";

export interface NetlifySiteRef {
  region: NetlifyRegion;
  /** Custom domain as shown in the Netlify project switcher; usable as API site_id. */
  site: string;
}

export interface RepoNetlifyProjects {
  us: NetlifySiteRef;
  mx: NetlifySiteRef;
}

/**
 * GitHub catalog/repo name → Netlify US + MX projects.
 * Keys are normalized (lowercase, strip `-microfrontend` / `-forked`).
 */
const NETLIFY_PROJECTS_BY_REPO: Record<string, RepoNetlifyProjects> = {
  landings: {
    us: { region: "US", site: "landings.ipsy.com" },
    mx: { region: "MX", site: "landings.ipsy.mx" },
  },
  experiences: {
    us: { region: "US", site: "experiences.ipsy.com" },
    mx: { region: "MX", site: "experiences.ipsy.mx" },
  },
  blog: {
    us: { region: "US", site: "blog.ipsy.com" },
    mx: { region: "MX", site: "blog.ipsy.mx" },
  },
  quiz: {
    us: { region: "US", site: "quiz.ipsy.com" },
    mx: { region: "MX", site: "quiz.ipsy.mx" },
  },
};

/** blog-microfrontend → blog, landings-forked → landings */
export function netlifyRepoKey(repoName: string): string {
  return repoName
    .trim()
    .toLowerCase()
    .replace(/-forked$/, "")
    .replace(/[-_]microfrontend$/, "");
}

export function netlifyProjectsForRepo(repoName: string): RepoNetlifyProjects | undefined {
  return NETLIFY_PROJECTS_BY_REPO[netlifyRepoKey(repoName)];
}

export function netlifyMappedRepoNames(): string[] {
  return Object.keys(NETLIFY_PROJECTS_BY_REPO).sort();
}

export function netlifyProjectsForRepos(repoNames: string[]): RepoNetlifyProjects[] {
  const seen = new Set<string>();
  const matched: RepoNetlifyProjects[] = [];
  for (const name of repoNames) {
    const projects = netlifyProjectsForRepo(name);
    if (!projects) continue;
    if (seen.has(projects.us.site)) continue;
    seen.add(projects.us.site);
    matched.push(projects);
  }
  return matched;
}
