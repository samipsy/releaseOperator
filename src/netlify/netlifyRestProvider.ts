import { NetlifyServiceError } from "../errors.js";
import type { NetlifyBuild, NetlifyDeploy, NetlifyProvider } from "./types.js";

const NETLIFY_API_BASE = "https://api.netlify.com/api/v1";

export interface NetlifyRestProviderOptions {
  token: string;
  fetchImpl?: typeof fetch;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function stringField(rec: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = rec?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function dashboardDeployUrl(siteName: string, deployId: string): string {
  return `https://app.netlify.com/projects/${encodeURIComponent(siteName)}/deploys/${encodeURIComponent(deployId)}`;
}

/** Netlify's admin_url is often the project root; PCM rollback needs the deploy permalink. */
export function netlifyDeployPermalink(deployId: string, adminUrl?: string, siteName?: string): string | undefined {
  if (adminUrl && adminUrl.includes(deployId)) return adminUrl;
  if (adminUrl) {
    const root = adminUrl.replace(/\/+$/, "");
    if (/\/projects\/[^/]+$/.test(root)) return `${root}/deploys/${deployId}`;
  }
  if (siteName) return dashboardDeployUrl(siteName, deployId);
  return adminUrl;
}

function parseDeploy(value: unknown, siteName?: string): NetlifyDeploy | undefined {
  const rec = asRecord(value);
  const id = stringField(rec, "id");
  if (!id) return undefined;
  const name = siteName ?? stringField(rec, "name");
  const adminUrl = netlifyDeployPermalink(id, stringField(rec, "admin_url"), name);
  if (!adminUrl) return undefined;
  const createdRaw = stringField(rec, "created_at") ?? stringField(rec, "createdAt");
  const createdAt = createdRaw ? new Date(createdRaw) : undefined;
  return {
    id,
    adminUrl,
    ...(stringField(rec, "branch") ? { branch: stringField(rec, "branch") } : {}),
    ...(stringField(rec, "context") ? { context: stringField(rec, "context") } : {}),
    ...(stringField(rec, "state") ? { state: stringField(rec, "state") } : {}),
    ...(createdAt && !Number.isNaN(createdAt.getTime()) ? { createdAt } : {}),
  };
}

export class NetlifyRestProvider implements NetlifyProvider {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: NetlifyRestProviderOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async requestJson(
    method: "GET" | "POST",
    path: string,
    query?: Record<string, string>
  ): Promise<unknown> {
    const url = new URL(`${NETLIFY_API_BASE}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          "User-Agent": "release-operator",
        },
      });
    } catch (err) {
      throw new NetlifyServiceError(`Could not reach Netlify API ${path}. (${(err as Error).message})`, err);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new NetlifyServiceError(`Netlify API ${method} ${path} returned HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new NetlifyServiceError(`Netlify API ${method} ${path} returned non-JSON (HTTP ${res.status})`);
    }
  }

  private async getJson(path: string, query?: Record<string, string>): Promise<unknown> {
    return this.requestJson("GET", path, query);
  }

  private async listMainDeploys(siteId: string): Promise<unknown[]> {
    const encoded = encodeURIComponent(siteId);
    const payload = await this.getJson(`/sites/${encoded}/deploys`, {
      branch: "main",
      state: "ready",
      production: "true",
      per_page: "10",
    });
    return Array.isArray(payload) ? payload : [];
  }

  private async publishedDeploy(siteId: string): Promise<NetlifyDeploy | undefined> {
    const encoded = encodeURIComponent(siteId);
    const payload = asRecord(await this.getJson(`/sites/${encoded}`));
    const siteName = stringField(payload, "name") ?? siteId;
    const published = parseDeploy(payload?.published_deploy, siteName);
    if (!published) return undefined;
    const branch = published.branch?.toLowerCase();
    if (branch && branch !== "main" && branch !== "master") return undefined;
    return published;
  }

  async latestMainDeploy(siteId: string): Promise<NetlifyDeploy | undefined> {
    try {
      const listed = await this.listMainDeploys(siteId);
      for (const item of listed) {
        const parsed = parseDeploy(item);
        if (parsed) return parsed;
      }
    } catch (err) {
      if (!(err instanceof NetlifyServiceError) || !/HTTP 404/.test(err.message)) throw err;
    }
    return this.publishedDeploy(siteId);
  }

  async latestDeployForBranch(siteId: string, branch: string): Promise<NetlifyDeploy | undefined> {
    const encoded = encodeURIComponent(siteId);
    const payload = await this.getJson(`/sites/${encoded}/deploys`, {
      branch,
      per_page: "10",
    });
    const listed = Array.isArray(payload) ? payload : [];
    for (const item of listed) {
      const parsed = parseDeploy(item);
      if (parsed) return parsed;
    }
    return undefined;
  }

  async triggerBranchBuild(siteId: string, branch: string): Promise<NetlifyBuild> {
    const encoded = encodeURIComponent(siteId);
    const payload = asRecord(
      await this.requestJson("POST", `/sites/${encoded}/builds`, { branch })
    );
    const id = stringField(payload, "id");
    if (!id) {
      throw new NetlifyServiceError(
        `Netlify API POST /sites/${siteId}/builds returned no build id`
      );
    }
    const deployId = stringField(payload, "deploy_id");
    const sha = stringField(payload, "sha");
    return {
      id,
      ...(deployId ? { deployId } : {}),
      ...(sha ? { sha } : {}),
    };
  }
}
