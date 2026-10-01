import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { JiraServiceError } from "../src/errors.js";
import {
  buildAuthorizeUrl,
  DEFAULT_OAUTH_REDIRECT_URI,
  exchangeAuthorizationCode,
  oauthCredentialWarnings,
  pickAccessibleResource,
  redirectListenPort,
  sanitizeOAuthCredential,
  textToAdf,
} from "../src/jira/oauth.js";
import { JiraOAuthSession } from "../src/jira/oauthSession.js";
import { JiraRestProvider } from "../src/jira/jiraRestProvider.js";
import { readTokenStore, writeTokenStore } from "../src/jira/tokenStore.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("Atlassian 3LO helpers", () => {
  it("defaults the OAuth callback to port 8080 (mlx_lm.server uses 8081)", () => {
    expect(DEFAULT_OAUTH_REDIRECT_URI).toBe("http://localhost:8080/callback");
  });

  it("builds an authorize URL that includes offline_access", () => {
    const url = buildAuthorizeUrl({
      clientId: "client-abc",
      redirectUri: "http://localhost:8080/callback",
      state: "xyz",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://auth.atlassian.com/authorize");
    expect(parsed.searchParams.get("client_id")).toBe("client-abc");
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost:8080/callback");
    expect(parsed.searchParams.get("scope")?.split(" ")).toContain("offline_access");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("state")).toBe("xyz");
  });

  it("includes a PKCE S256 challenge on the authorize URL when provided", () => {
    const url = buildAuthorizeUrl({
      clientId: "client-abc",
      redirectUri: "http://localhost:8080/callback",
      codeChallenge: "abcChallenge",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("code_challenge")).toBe("abcChallenge");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("reads the listen port from the redirect URI", () => {
    expect(redirectListenPort("http://localhost:8787/callback")).toBe(8787);
    expect(redirectListenPort("http://localhost:8080/callback")).toBe(8080);
  });

  it("exchanges an authorization code without putting a stray quote in the JSON body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ access_token: "tok", refresh_token: "ref", expires_in: 3600, token_type: "Bearer" })
    );
    const result = await exchangeAuthorizationCode({
      clientId: "id",
      clientSecret: "secret",
      code: "auth-code",
      redirectUri: "http://localhost:8080/callback",
      fetchImpl,
    });
    expect(result.access_token).toBe("tok");
    expect(result.refresh_token).toBe("ref");
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1].body)) as Record<string, string>;
    expect(body.client_secret).toBe("secret");
    expect(body.grant_type).toBe("authorization_code");
    expect(body.redirect_uri).toBe("http://localhost:8080/callback");
  });

  it("explains HTTP 401 as a client auth rejection after trying post, basic, and form", async () => {
    const fetchImpl = vi.fn().mockImplementation(
      () => new Response("Unauthorized", { status: 401, statusText: "Unauthorized" })
    );
    await expect(
      exchangeAuthorizationCode({
        clientId: "oauth-app-id",
        clientSecret: "wrong",
        code: "auth-code",
        redirectUri: "http://localhost:8080/callback",
        fetchImpl,
      })
    ).rejects.toThrow(/HTTP Basic/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("retries with HTTP Basic when JSON client_secret_post returns 401", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }))
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "tok", refresh_token: "ref", expires_in: 3600, token_type: "Bearer" })
      );
    const result = await exchangeAuthorizationCode({
      clientId: "id",
      clientSecret: "secret",
      code: "auth-code",
      redirectUri: "http://localhost:8080/callback",
      fetchImpl,
    });
    expect(result.access_token).toBe("tok");
    const secondHeaders = fetchImpl.mock.calls[1][1].headers as Record<string, string>;
    expect(secondHeaders.Authorization).toMatch(/^Basic /);
  });

  it("warns when client_id looks like a cloud UUID or secret looks like a JWT", () => {
    expect(sanitizeOAuthCredential(`"secret"`)).toBe("secret");
    expect(oauthCredentialWarnings("11111111-1111-4111-8111-111111111111", "ATOAsecret")).toEqual(
      expect.arrayContaining([expect.stringMatching(/cloud UUID/)])
    );
    expect(oauthCredentialWarnings("oauthAppId", "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.sig")).toEqual(
      expect.arrayContaining([expect.stringMatching(/JWT access token/)])
    );
  });

  it("picks a matching Atlassian site from accessible-resources", () => {
    const picked = pickAccessibleResource(
      [
        { id: "care", url: "https://ipsycare.atlassian.net" },
        { id: "corp", url: "https://ipsycorp.atlassian.net" },
      ],
      "https://ipsycorp.atlassian.net/"
    );
    expect(picked.id).toBe("corp");
  });

  it("encodes plain text as a minimal ADF document", () => {
    expect(textToAdf("hello\nworld")).toEqual({
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "hello" }, { type: "hardBreak" }, { type: "text", text: "world" }],
        },
      ],
    });
  });

  it("encodes markdown bold as ADF strong marks", () => {
    expect(textToAdf("**Environment(s) Affected:** Prod - US/MX")).toEqual({
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Environment(s) Affected:", marks: [{ type: "strong" }] },
            { type: "text", text: " Prod - US/MX" },
          ],
        },
      ],
    });
  });

  it("encodes a markdown table as an ADF table with Jira links", () => {
    const adf = textToAdf(
      [
        "Change-management ticket for release 1.0.0 (prod).",
        "",
        "| Ticket # | Title | Author | PR # |",
        "| --- | --- | --- | --- |",
        '| <a href="https://ipsycorp.atlassian.net/browse/PCM-7"><span style="white-space:nowrap">PCM&#8209;7</span></a> | Glow bag copy | @sam | #88 |',
      ].join("\n")
    );
    const blocks = adf.content as Record<string, unknown>[];
    expect(blocks[0]).toEqual({
      type: "paragraph",
      content: [
        { type: "text", text: "Change-management ticket for release 1.0.0 (prod)." },
        { type: "hardBreak" },
      ],
    });
    expect(blocks[1]).toMatchObject({ type: "table" });
    const table = blocks[1] as { content: { content: { content: { content: unknown[] }[] }[] }[] };
    const firstDataCell = table.content[1].content[0].content[0].content[0] as {
      type: string;
      text: string;
      marks: { type: string; attrs: { href: string } }[];
    };
    expect(firstDataCell).toEqual({
      type: "text",
      text: "PCM\u20117",
      marks: [{ type: "link", attrs: { href: "https://ipsycorp.atlassian.net/browse/PCM-7" } }],
    });
  });
});

describe("JiraOAuthSession", () => {
  it("refreshes an expired access token and persists the rotated refresh token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ro-jira-oauth-"));
    const storePath = join(dir, "tokens.json");
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 })
    );
    const session = new JiraOAuthSession({
      clientId: "id",
      clientSecret: "secret",
      storePath,
      now: () => 1_000_000,
      fetchImpl,
      tokens: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: 1,
        tokenType: "Bearer",
        cloudId: "cloud-1",
        siteUrl: "https://ipsycorp.atlassian.net",
      },
    });

    const token = await session.getAccessToken();
    expect(token).toBe("new-access");
    const stored = readTokenStore(storePath);
    expect(stored?.refreshToken).toBe("new-refresh");
    expect(stored?.accessToken).toBe("new-access");
  });

  it("refuses to refresh when there is no refresh_token", async () => {
    const session = new JiraOAuthSession({
      now: () => 1_000_000,
      tokens: {
        accessToken: "old",
        expiresAt: 1,
        tokenType: "Bearer",
        cloudId: "c",
        siteUrl: "https://example.atlassian.net",
      },
    });
    await expect(session.getAccessToken()).rejects.toThrow(/no refresh_token/);
  });
});

describe("JiraRestProvider", () => {
  it("creates an issue and comments via Jira Cloud REST", async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).endsWith("/issue") && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ key: "PCM-42", id: "10001" }));
      }
      if (String(url).includes("/comment")) {
        return Promise.resolve(jsonResponse({ id: "10050" }));
      }
      if (String(url).endsWith("/issueLink") && init?.method === "POST") {
        return Promise.resolve(new Response("", { status: 201 }));
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    });
    const provider = new JiraRestProvider({
      getAccessToken: async () => "bearer-tok",
      cloudId: "cloud-corp",
      siteUrl: "https://ipsycorp.atlassian.net/",
      fetchImpl,
    });

    const created = await provider.createIssue({
      projectKey: "PCM",
      summary: "Release 1.0.0 (prod)",
      issueType: "Task",
      description: "Body",
    });
    expect(created).toEqual({
      key: "PCM-42",
      url: "https://ipsycorp.atlassian.net/browse/PCM-42",
      raw: expect.any(String),
    });
    const createCall = fetchImpl.mock.calls[0];
    expect(createCall[0]).toBe("https://api.atlassian.com/ex/jira/cloud-corp/rest/api/3/issue");
    expect((createCall[1]?.headers as Record<string, string>).Authorization).toBe("Bearer bearer-tok");

    const commented = await provider.addComment({ issueKey: "PCM-42", body: "notes" });
    expect(commented.raw).toContain("10050");

    const linked = await provider.createIssueLink({
      inwardIssue: "MET-4274",
      outwardIssue: "PCM-42",
      type: "Relates",
    });
    expect(linked.raw).toBe("");
    const linkCall = fetchImpl.mock.calls[2];
    expect(linkCall[0]).toBe("https://api.atlassian.com/ex/jira/cloud-corp/rest/api/3/issueLink");
    expect(JSON.parse(String(linkCall[1]?.body))).toEqual({
      type: { name: "Relates" },
      inwardIssue: { key: "MET-4274" },
      outwardIssue: { key: "PCM-42" },
    });
  });

  it("sets parent Epic and extra fields on create", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ key: "PCM-99" }));
    const provider = new JiraRestProvider({
      getAccessToken: async () => "tok",
      cloudId: "cloud-corp",
      siteUrl: "https://ipsycorp.atlassian.net",
      fetchImpl,
    });
    await provider.createIssue({
      projectKey: "PCM",
      summary: "Release 1.0.0 (prod)",
      issueType: "Task",
      parentKey: "PCM-10",
      extraFields: { labels: ["release"] },
    });
    const sent = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)) as {
      fields: Record<string, unknown>;
    };
    expect(sent.fields.parent).toEqual({ key: "PCM-10" });
    expect(sent.fields.labels).toEqual(["release"]);
    expect(sent.fields.project).toEqual({ key: "PCM" });
  });

  it("loads summary and description for getIssue", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        key: "PCM-10",
        fields: {
          summary: "Assign epic",
          description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Do the thing." }] }] },
          status: { name: "Change Applied" },
        },
      })
    );
    const provider = new JiraRestProvider({
      getAccessToken: async () => "tok",
      cloudId: "cloud-corp",
      siteUrl: "https://ipsycorp.atlassian.net",
      fetchImpl,
    });
    const issue = await provider.getIssue("PCM-10");
    expect(issue).toEqual({
      key: "PCM-10",
      summary: "Assign epic",
      description: "Do the thing.",
      url: "https://ipsycorp.atlassian.net/browse/PCM-10",
      status: "Change Applied",
    });
  });

  it("throws JiraServiceError on a non-OK REST response", async () => {
    const provider = new JiraRestProvider({
      getAccessToken: async () => "tok",
      cloudId: "cloud",
      siteUrl: "https://ipsycorp.atlassian.net",
      fetchImpl: vi.fn().mockResolvedValue(new Response("project not found", { status: 400 })),
    });
    await expect(
      provider.createIssue({ projectKey: "NOPE", summary: "x", issueType: "Task" })
    ).rejects.toThrow(JiraServiceError);
  });

  it("looks up JSM services even when searchServices is called unbound", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([{ id: "ari:cloud:graph::service/cloud/svc", name: "web" }])
    );
    const provider = new JiraRestProvider({
      getAccessToken: async () => "tok",
      cloudId: "cloud-corp",
      siteUrl: "https://ipsycorp.atlassian.net",
      fetchImpl,
    });
    const search = provider.searchServices;
    const hits = await search("web");
    expect(hits).toEqual([{ id: "ari:cloud:graph::service/cloud/svc", name: "web" }]);
    expect(String(fetchImpl.mock.calls[0][0])).toContain(
      "/ex/jira/cloud-corp/rest/service-registry-api/service?query=web"
    );
  });
});

describe("token store", () => {
  it("round-trips tokens to a local file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ro-jira-store-"));
    const path = join(dir, "tokens.json");
    writeTokenStore(
      {
        accessToken: "a",
        refreshToken: "r",
        expiresAt: 9,
        tokenType: "Bearer",
        cloudId: "c",
        siteUrl: "https://ipsycorp.atlassian.net",
      },
      path
    );
    expect(JSON.parse(readFileSync(path, "utf8")).accessToken).toBe("a");
    expect(readTokenStore(path)?.refreshToken).toBe("r");
  });
});
