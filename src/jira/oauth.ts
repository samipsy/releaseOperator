import { createHash, randomBytes } from "node:crypto";
import { JiraServiceError } from "../errors.js";

export const DEFAULT_OAUTH_AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
export const DEFAULT_OAUTH_TOKEN_URL = "https://auth.atlassian.com/oauth/token";
export const DEFAULT_OAUTH_AUDIENCE = "api.atlassian.com";
/** Loopback callback on 8080. mlx_lm.server is bound to 8081 so these do not collide. */
export const DEFAULT_OAUTH_REDIRECT_URI = "http://localhost:8080/callback";
export const DEFAULT_OAUTH_SCOPES = [
  "read:jira-work",
  "write:jira-work",
  "read:jira-user",
  "offline_access",
] as const;
export const ACCESSIBLE_RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";
export const JIRA_API_PREFIX = "https://api.atlassian.com/ex/jira";

export interface AtlassianTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
}

export interface AccessibleAtlassianResource {
  id: string;
  url: string;
  name?: string;
  scopes?: string[];
  avatarUrl?: string;
}

export interface BuildAuthorizeUrlInput {
  clientId: string;
  redirectUri: string;
  scopes?: readonly string[];
  state?: string;
  authorizeUrl?: string;
  audience?: string;
  codeChallenge?: string;
}

export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(input: BuildAuthorizeUrlInput): string {
  const url = new URL(input.authorizeUrl ?? DEFAULT_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("audience", input.audience ?? DEFAULT_OAUTH_AUDIENCE);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("scope", (input.scopes ?? DEFAULT_OAUTH_SCOPES).join(" "));
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state ?? "release-operator");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("prompt", "consent");
  if (input.codeChallenge) {
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

export function redirectListenPort(redirectUri: string): number {
  const parsed = new URL(redirectUri);
  if (parsed.port) return Number(parsed.port);
  return parsed.protocol === "https:" ? 443 : 80;
}

interface TokenRequest {
  tokenUrl?: string;
  fetchImpl?: typeof fetch;
  clientId: string;
  clientSecret: string;
  fields: Record<string, string>;
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
}

async function postToken(request: TokenRequest): Promise<AtlassianTokenResponse> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const tokenUrl = request.tokenUrl ?? DEFAULT_OAUTH_TOKEN_URL;
  const { clientId, clientSecret, fields } = request;

  const attempts: { name: string; headers: Record<string, string>; body: string }[] = [
    {
      name: "client_secret_post_json",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ ...fields, client_id: clientId, client_secret: clientSecret }),
    },
    {
      name: "client_secret_basic_json",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: basicAuthHeader(clientId, clientSecret),
      },
      body: JSON.stringify(fields),
    },
    {
      name: "client_secret_post_form",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ ...fields, client_id: clientId, client_secret: clientSecret }).toString(),
    },
  ];

  let lastStatus = 0;
  let lastSummary = "";
  for (const attempt of attempts) {
    let res: Response;
    try {
      res = await fetchImpl(tokenUrl, { method: "POST", headers: attempt.headers, body: attempt.body });
    } catch (err) {
      throw new JiraServiceError(
        `Could not reach the Atlassian token endpoint at ${tokenUrl}. (${(err as Error).message})`,
        err
      );
    }
    const text = await res.text();
    if (res.ok) return parseTokenResponse(text);
    lastStatus = res.status;
    lastSummary = summarizeTokenError(text);
    if (res.status !== 401) {
      throw new JiraServiceError(
        `Atlassian token endpoint returned HTTP ${res.status} ${res.statusText}: ${lastSummary}`
      );
    }
  }

  throw new JiraServiceError(
    `Atlassian token endpoint returned HTTP ${lastStatus} Unauthorized (${lastSummary}) after trying ` +
      `JSON body, HTTP Basic, and form-urlencoded client auth. The browser callback only means the code was ` +
      `issued. redirect_uri in the token request must match the authorize URL and the developer console ` +
      `exactly (currently sent as ${fields.redirect_uri ?? "(none)"}). A shell export of ` +
      `RELEASE_OPERATOR_JIRA_OAUTH_CLIENT_SECRET overrides .env. Client id sent: ${clientId}. ` +
      `Run jira login again — do not reuse a callback URL.`
  );
}

function parseTokenResponse(text: string): AtlassianTokenResponse {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const accessToken = parsed.access_token;
  const expiresIn = parsed.expires_in;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new JiraServiceError("Atlassian token endpoint returned no access_token");
  }
  if (typeof expiresIn !== "number") {
    throw new JiraServiceError("Atlassian token endpoint returned no expires_in");
  }

  return {
    access_token: accessToken,
    refresh_token: typeof parsed.refresh_token === "string" ? parsed.refresh_token : undefined,
    expires_in: expiresIn,
    token_type: typeof parsed.token_type === "string" ? parsed.token_type : undefined,
    scope: typeof parsed.scope === "string" ? parsed.scope : undefined,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sanitizeOAuthCredential(value: string): string {
  let v = value.trim().replace(/^\uFEFF/, "");
  if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
    v = v.slice(1, -1).trim();
  }
  if (v.startsWith('"') && !v.endsWith('"')) v = v.slice(1);
  if (v.endsWith('"') && !v.startsWith('"')) v = v.slice(0, -1);
  if (v.startsWith("'") && !v.endsWith("'")) v = v.slice(1);
  if (v.endsWith("'") && !v.startsWith("'")) v = v.slice(0, -1);
  return v.trim();
}

export function oauthCredentialWarnings(clientId: string, clientSecret: string): string[] {
  const warnings: string[] = [];
  if (UUID_RE.test(clientId)) {
    warnings.push(
      "RELEASE_OPERATOR_JIRA_OAUTH_CLIENT_ID looks like a Jira cloud UUID; use the OAuth 2.0 client id from the Atlassian developer console."
    );
  }
  if (clientSecret.startsWith("eyJ")) {
    warnings.push(
      "RELEASE_OPERATOR_JIRA_OAUTH_CLIENT_SECRET looks like a JWT access token, not the app Client secret."
    );
  }
  return warnings;
}

function summarizeTokenError(text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const description = parsed.error_description;
    const error = parsed.error;
    if (typeof description === "string") return description;
    if (typeof error === "string") return error;
  } catch {
    // fall through
  }
  return text.slice(0, 300);
}

export async function exchangeAuthorizationCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier?: string;
  tokenUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<AtlassianTokenResponse> {
  const fields: Record<string, string> = {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
  };
  if (input.codeVerifier) fields.code_verifier = input.codeVerifier;
  return postToken({
    tokenUrl: input.tokenUrl,
    fetchImpl: input.fetchImpl,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    fields,
  });
}

export async function refreshAccessToken(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<AtlassianTokenResponse> {
  return postToken({
    tokenUrl: input.tokenUrl,
    fetchImpl: input.fetchImpl,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    fields: {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    },
  });
}

export async function listAccessibleResources(input: {
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<AccessibleAtlassianResource[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(ACCESSIBLE_RESOURCES_URL, {
      headers: { Authorization: `Bearer ${input.accessToken}`, Accept: "application/json" },
    });
  } catch (err) {
    throw new JiraServiceError(
      `Could not reach Atlassian accessible-resources. (${(err as Error).message})`,
      err
    );
  }
  const text = await res.text();
  if (!res.ok) {
    throw new JiraServiceError(
      `Atlassian accessible-resources returned HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`
    );
  }
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) {
    throw new JiraServiceError("Atlassian accessible-resources did not return an array");
  }
  return parsed.filter(isAccessibleResource);
}

function isAccessibleResource(value: unknown): value is AccessibleAtlassianResource {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.id === "string" && typeof rec.url === "string";
}

export function normalizeSiteUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/^https?:\/\//, "").toLowerCase();
}

export function pickAccessibleResource(
  resources: AccessibleAtlassianResource[],
  siteUrl?: string
): AccessibleAtlassianResource {
  if (siteUrl) {
    const wanted = normalizeSiteUrl(siteUrl);
    const match = resources.find((r) => normalizeSiteUrl(r.url) === wanted);
    if (!match) {
      const available = resources.map((r) => r.url).join(", ") || "(none)";
      throw new JiraServiceError(
        `No accessible Atlassian site matched "${siteUrl}". Sites available to this account: ${available}`
      );
    }
    return match;
  }
  if (resources.length === 1) return resources[0];
  if (resources.length === 0) {
    throw new JiraServiceError("This Atlassian account has no accessible Jira Cloud sites");
  }
  const available = resources.map((r) => r.url).join(", ");
  throw new JiraServiceError(
    `Multiple Atlassian sites are accessible (${available}). Set RELEASE_OPERATOR_JIRA_SITE to pick one.`
  );
}

const GFM_TABLE_SEPARATOR = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function looksLikeGfmTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.includes("|", 1);
}

function splitGfmTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function stripHtmlTags(value: string): string {
  return value.replace(/<\/?[^>]+>/g, "");
}

function decodeHtmlEntities(value: string): string {
  return value
    .replaceAll("&#8209;", "\u2011")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function markdownCellToAdfInline(cell: string): unknown[] {
  const decoded = decodeHtmlEntities(cell.trim());
  const link = decoded.match(/^<a\s+href="([^"]*)"[^>]*>([\s\S]*)<\/a>$/i);
  if (link) {
    const href = decodeHtmlEntities(link[1]);
    const text = stripHtmlTags(decodeHtmlEntities(link[2]));
    if (!text) return [];
    return [{ type: "text", text, marks: [{ type: "link", attrs: { href } }] }];
  }
  const text = stripHtmlTags(decoded);
  return text ? [{ type: "text", text }] : [];
}

function adfTableCell(kind: "tableHeader" | "tableCell", raw: string): Record<string, unknown> {
  const inline = markdownCellToAdfInline(raw);
  return {
    type: kind,
    content: [{ type: "paragraph", content: inline }],
  };
}

function gfmTableToAdf(header: string[], rows: string[][]): Record<string, unknown> {
  const width = header.length;
  const pad = (cells: string[]): string[] => {
    const next = cells.slice(0, width);
    while (next.length < width) next.push("");
    return next;
  };
  return {
    type: "table",
    attrs: { isNumberColumnEnabled: false, layout: "default" },
    content: [
      { type: "tableRow", content: pad(header).map((cell) => adfTableCell("tableHeader", cell)) },
      ...rows.map((row) => ({
        type: "tableRow",
        content: pad(row).map((cell) => adfTableCell("tableCell", cell)),
      })),
    ],
  };
}

function markdownLineToAdfInline(line: string): unknown[] {
  const nodes: unknown[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  for (const match of line.matchAll(re)) {
    const start = match.index ?? 0;
    if (start > last) {
      nodes.push({ type: "text", text: line.slice(last, start) });
    }
    nodes.push({ type: "text", text: match[1], marks: [{ type: "strong" }] });
    last = start + match[0].length;
  }
  if (last < line.length) {
    nodes.push({ type: "text", text: line.slice(last) });
  }
  return nodes;
}

function paragraphFromLines(lines: string[]): Record<string, unknown> | undefined {
  if (lines.length === 0) return undefined;
  const content: unknown[] = [];
  for (let i = 0; i < lines.length; i++) {
    const inline = markdownLineToAdfInline(lines[i]);
    if (inline.length > 0) content.push(...inline);
    if (i < lines.length - 1) content.push({ type: "hardBreak" });
  }
  return { type: "paragraph", content };
}

export function textToAdf(text: string): { type: "doc"; version: 1; content: unknown[] } {
  const lines = text.length === 0 ? [""] : text.split("\n");
  const blocks: unknown[] = [];
  let i = 0;
  let buffer: string[] = [];

  const flushParagraph = (): void => {
    const para = paragraphFromLines(buffer);
    if (para) blocks.push(para);
    buffer = [];
  };

  while (i < lines.length) {
    const separator = lines[i + 1];
    if (
      looksLikeGfmTableRow(lines[i]) &&
      separator !== undefined &&
      GFM_TABLE_SEPARATOR.test(separator.trim())
    ) {
      flushParagraph();
      const header = splitGfmTableRow(lines[i]);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && looksLikeGfmTableRow(lines[i])) {
        rows.push(splitGfmTableRow(lines[i]));
        i += 1;
      }
      blocks.push(gfmTableToAdf(header, rows));
      continue;
    }
    buffer.push(lines[i]);
    i += 1;
  }
  flushParagraph();
  if (blocks.length === 0) {
    blocks.push({ type: "paragraph", content: [] });
  }
  return {
    type: "doc",
    version: 1,
    content: blocks,
  };
}

/**
 * Jira Cloud REST v3 wiki/textarea fields (Environment, Implementation plan, etc.) reject plain
 * strings and require Atlassian Document Format.
 */
const JIRA_V3_ADF_STRING_FIELDS = new Set([
  "description",
  "environment",
  "customfield_10130",
  "customfield_10132",
  "customfield_10486",
]);

export function applyAdfToJiraFields(fields: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...fields };
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === "string" && JIRA_V3_ADF_STRING_FIELDS.has(key)) {
      next[key] = textToAdf(value);
    }
  }
  return next;
}

/** Flatten Atlassian Document Format (or a plain string) to a short text summary. */
export function adfToPlainText(value: unknown, maxLen = 400): string {
  const parts: string[] = [];
  walkAdf(value, parts);
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen).trim()}…`;
}

function walkAdf(node: unknown, out: string[]): void {
  if (typeof node === "string") {
    if (node.trim()) out.push(node.trim());
    return;
  }
  if (!node || typeof node !== "object") return;
  const rec = node as Record<string, unknown>;
  if (typeof rec.text === "string" && rec.text.trim()) out.push(rec.text.trim());
  if (Array.isArray(rec.content)) {
    for (const child of rec.content) walkAdf(child, out);
  }
}
