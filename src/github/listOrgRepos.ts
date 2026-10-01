import { GithubServiceError } from "../errors.js";
import type { McpContentBlock, McpToolCaller } from "../mcp/types.js";
import type { CatalogRepo } from "./repoCatalog.js";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

export interface ListOrgReposOptions {
  org: string;
  caller?: McpToolCaller;
  token?: string;
  fetchImpl?: typeof fetch;
}

function extractText(content: McpContentBlock[]): string {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function catalogRepoFromUnknown(value: unknown): CatalogRepo | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const name = typeof rec.name === "string" ? rec.name : undefined;
  const htmlUrl = typeof rec.html_url === "string" ? rec.html_url : typeof rec.url === "string" ? rec.url : undefined;
  const fullName = typeof rec.full_name === "string" ? rec.full_name : undefined;
  const ownerRec = asRecord(rec.owner);
  const ownerFromObj = typeof ownerRec?.login === "string" ? ownerRec.login : undefined;
  const ownerFromFull = fullName?.includes("/") ? fullName.slice(0, fullName.indexOf("/")) : undefined;
  const owner = ownerFromObj ?? ownerFromFull;
  const defaultBranch = typeof rec.default_branch === "string" && rec.default_branch.length > 0 ? rec.default_branch : undefined;
  if (!name || !owner) return undefined;
  return {
    name,
    owner,
    fullName: fullName ?? `${owner}/${name}`,
    url: htmlUrl && htmlUrl.startsWith("http") ? htmlUrl : `https://github.com/${owner}/${name}`,
    ...(defaultBranch ? { defaultBranch } : {}),
  };
}

function extractRepoArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  const rec = asRecord(parsed);
  if (!rec) return [];
  for (const key of ["repositories", "repos", "items", "data"]) {
    const value = rec[key];
    if (Array.isArray(value)) return value;
    const nested = asRecord(value);
    if (nested) {
      for (const inner of ["repositories", "repos", "items"]) {
        if (Array.isArray(nested[inner])) return nested[inner] as unknown[];
      }
    }
  }
  return [];
}

function parseRepoList(text: string): CatalogRepo[] {
  const parsed = tryParseJson(text);
  return extractRepoArray(parsed)
    .map(catalogRepoFromUnknown)
    .filter((repo): repo is CatalogRepo => repo !== undefined);
}

/**
 * Pages through an org's repositories via GitHub MCP (`list_org_repositories`, then
 * `search_repositories`), falling back to REST GET /orgs/{org}/repos if those tools
 * are missing — same isolated REST exception pattern as tagging.
 */
export async function listOrgRepositories(options: ListOrgReposOptions): Promise<CatalogRepo[]> {
  if (options.caller) {
    try {
      return await listViaMcp(options.caller, options.org);
    } catch (err) {
      if (!options.token) throw err;
      const message = (err as Error).message;
      if (!/unknown tool|not found|does not exist|tool .* not/i.test(message)) throw err;
    }
  }
  if (!options.token) {
    throw new GithubServiceError("Cannot list org repos: GitHub MCP failed and no token is available for REST fallback");
  }
  return listViaRest(options.org, options.token, options.fetchImpl ?? fetch);
}

async function listViaMcp(caller: McpToolCaller, org: string): Promise<CatalogRepo[]> {
  const collected: CatalogRepo[] = [];
  let tool: "list_org_repositories" | "search_repositories" = "list_org_repositories";
  for (let page = 1; page <= MAX_PAGES; page++) {
    const args =
      tool === "list_org_repositories"
        ? { org, perPage: PAGE_SIZE, page }
        : { query: `org:${org}`, perPage: PAGE_SIZE, page };
    let text: string;
    try {
      text = await callMcp(caller, tool, args);
    } catch (err) {
      if (page === 1 && tool === "list_org_repositories") {
        tool = "search_repositories";
        text = await callMcp(caller, tool, { query: `org:${org}`, perPage: PAGE_SIZE, page });
      } else {
        throw err;
      }
    }
    const batch = parseRepoList(text);
    collected.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return dedupe(collected);
}

async function callMcp(caller: McpToolCaller, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await caller.callTool({ name, arguments: args });
  const text = extractText(result.content ?? []);
  if (result.isError) {
    throw new GithubServiceError(`GitHub MCP tool "${name}" reported failure: ${text || "(no details returned)"}`);
  }
  return text;
}

async function listViaRest(org: string, token: string, fetchImpl: typeof fetch): Promise<CatalogRepo[]> {
  const collected: CatalogRepo[] = [];
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${GITHUB_API_BASE}/orgs/${encodeURIComponent(org)}/repos?per_page=${PAGE_SIZE}&page=${page}&type=all`;
    let res: Response;
    try {
      res = await fetchImpl(url, { headers });
    } catch (err) {
      throw new GithubServiceError(`Could not list repos for org ${org} via REST. (${(err as Error).message})`, err);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new GithubServiceError(
        `GitHub REST list-org-repos for ${org} returned HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`
      );
    }
    const batch = parseRepoList(text);
    collected.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return dedupe(collected);
}

function dedupe(repos: CatalogRepo[]): CatalogRepo[] {
  const byFullName = new Map<string, CatalogRepo>();
  for (const repo of repos) byFullName.set(repo.fullName.toLowerCase(), repo);
  return [...byFullName.values()];
}
