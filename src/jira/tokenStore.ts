import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { JiraServiceError } from "../errors.js";

export const DEFAULT_TOKEN_STORE_PATH = "./.jira-oauth.json";

export interface JiraOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  tokenType: string;
  cloudId?: string;
  siteUrl?: string;
  scope?: string;
}

export function tokenStorePath(): string {
  return resolve(process.env.RELEASE_OPERATOR_JIRA_OAUTH_STORE ?? DEFAULT_TOKEN_STORE_PATH);
}

export function readTokenStore(path?: string): JiraOAuthTokens | undefined {
  const dest = path ?? tokenStorePath();
  if (!existsSync(dest)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(dest, "utf8")) as Record<string, unknown>;
    if (typeof parsed.accessToken !== "string" || typeof parsed.expiresAt !== "number") {
      throw new Error("missing accessToken or expiresAt");
    }
    return {
      accessToken: parsed.accessToken,
      refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : undefined,
      expiresAt: parsed.expiresAt,
      tokenType: typeof parsed.tokenType === "string" ? parsed.tokenType : "Bearer",
      cloudId: typeof parsed.cloudId === "string" ? parsed.cloudId : undefined,
      siteUrl: typeof parsed.siteUrl === "string" ? parsed.siteUrl : undefined,
      scope: typeof parsed.scope === "string" ? parsed.scope : undefined,
    };
  } catch (err) {
    throw new JiraServiceError(`Could not read Jira OAuth token store at ${dest}: ${(err as Error).message}`, err);
  }
}

export function writeTokenStore(tokens: JiraOAuthTokens, path?: string): void {
  const dest = path ?? tokenStorePath();
  const dir = dirname(dest);
  if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
  writeFileSync(dest, `${JSON.stringify(tokens, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(dest, 0o600);
  } catch {
    // best-effort on filesystems that ignore mode
  }
}

export function clearTokenStore(path?: string): void {
  const dest = path ?? tokenStorePath();
  if (existsSync(dest)) unlinkSync(dest);
}
