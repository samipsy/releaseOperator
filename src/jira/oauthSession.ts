import { JiraServiceError } from "../errors.js";
import {
  exchangeAuthorizationCode,
  listAccessibleResources,
  oauthCredentialWarnings,
  pickAccessibleResource,
  refreshAccessToken,
  sanitizeOAuthCredential,
  type AtlassianTokenResponse,
} from "./oauth.js";
import { readTokenStore, tokenStorePath, writeTokenStore, type JiraOAuthTokens } from "./tokenStore.js";

const EXPIRY_SKEW_MS = 60_000;

export interface JiraOAuthClientConfig {
  clientId?: string;
  clientSecret?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  storePath?: string;
}

export function oauthClientConfigFromEnv(): { clientId: string; clientSecret: string; warnings: string[] } | undefined {
  const rawId = process.env.RELEASE_OPERATOR_JIRA_OAUTH_CLIENT_ID;
  const rawSecret = process.env.RELEASE_OPERATOR_JIRA_OAUTH_CLIENT_SECRET;
  if (!rawId || !rawSecret) return undefined;
  const clientId = sanitizeOAuthCredential(rawId);
  const clientSecret = sanitizeOAuthCredential(rawSecret);
  if (!clientId || !clientSecret) return undefined;
  return {
    clientId,
    clientSecret,
    warnings: oauthCredentialWarnings(clientId, clientSecret),
  };
}

export class JiraOAuthSession {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly storePath?: string;
  private tokens: JiraOAuthTokens | undefined;

  constructor(options: JiraOAuthClientConfig & { tokens?: JiraOAuthTokens }) {
    this.clientId = options.clientId ?? "";
    this.clientSecret = options.clientSecret ?? "";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.storePath = options.storePath;
    this.tokens = options.tokens;
  }

  static fromStore(config: JiraOAuthClientConfig): JiraOAuthSession | undefined {
    const tokens = readTokenStore(config.storePath);
    if (!tokens) return undefined;
    return new JiraOAuthSession({ ...config, tokens });
  }

  snapshot(): JiraOAuthTokens {
    if (!this.tokens) throw new JiraServiceError("No Jira OAuth tokens are loaded");
    return { ...this.tokens };
  }

  async completeAuthorizationCode(input: {
    code: string;
    redirectUri: string;
    siteUrl?: string;
    cloudId?: string;
    codeVerifier?: string;
  }): Promise<JiraOAuthTokens> {
    this.requireClientCredentials("exchange an authorization code");
    const response = await exchangeAuthorizationCode({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      code: input.code,
      redirectUri: input.redirectUri,
      codeVerifier: input.codeVerifier,
      fetchImpl: this.fetchImpl,
    });
    return this.persistFromResponse(response, input.siteUrl, input.cloudId);
  }

  async importAccessToken(input: {
    accessToken: string;
    expiresAt?: number;
    siteUrl?: string;
    cloudId?: string;
  }): Promise<JiraOAuthTokens> {
    const expiresAt = input.expiresAt ?? this.now() + 3_600_000;
    return this.persistFromResponse(
      {
        access_token: input.accessToken,
        expires_in: Math.max(1, Math.floor((expiresAt - this.now()) / 1000)),
      },
      input.siteUrl,
      input.cloudId
    );
  }

  async getAccessToken(): Promise<string> {
    if (!this.tokens) throw new JiraServiceError("No Jira OAuth tokens are loaded — run `jira login`");
    if (this.tokens.expiresAt - EXPIRY_SKEW_MS > this.now()) return this.tokens.accessToken;
    if (!this.tokens.refreshToken) {
      throw new JiraServiceError(
        "Jira OAuth access token is expired and no refresh_token is stored. " +
          "Re-run `jira login` (the authorize URL includes offline_access so Atlassian will issue a refresh token)."
      );
    }
    this.requireClientCredentials("refresh an access token");
    const response = await refreshAccessToken({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      refreshToken: this.tokens.refreshToken,
      fetchImpl: this.fetchImpl,
    });
    await this.persistFromResponse(response, this.tokens.siteUrl, this.tokens.cloudId);
    return this.tokens.accessToken;
  }

  private async persistFromResponse(
    response: AtlassianTokenResponse,
    siteUrl?: string,
    cloudId?: string
  ): Promise<JiraOAuthTokens> {
    const next: JiraOAuthTokens = {
      accessToken: response.access_token,
      refreshToken: response.refresh_token ?? this.tokens?.refreshToken,
      expiresAt: this.now() + response.expires_in * 1000,
      tokenType: response.token_type ?? "Bearer",
      scope: response.scope ?? this.tokens?.scope,
      siteUrl: siteUrl ?? this.tokens?.siteUrl,
      cloudId: cloudId ?? this.tokens?.cloudId,
    };

    if (!next.cloudId || !next.siteUrl) {
      const resources = await listAccessibleResources({
        accessToken: next.accessToken,
        fetchImpl: this.fetchImpl,
      });
      const picked = pickAccessibleResource(resources, next.siteUrl ?? siteUrl);
      next.cloudId = picked.id;
      next.siteUrl = picked.url;
    }

    this.tokens = next;
    writeTokenStore(next, this.storePath ?? tokenStorePath());
    return next;
  }

  private requireClientCredentials(action: string): void {
    if (!this.clientId || !this.clientSecret) {
      throw new JiraServiceError(
        `Cannot ${action} without RELEASE_OPERATOR_JIRA_OAUTH_CLIENT_ID and RELEASE_OPERATOR_JIRA_OAUTH_CLIENT_SECRET.`
      );
    }
  }
}
