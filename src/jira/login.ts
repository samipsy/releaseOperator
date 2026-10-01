import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { JiraServiceError } from "../errors.js";
import { buildAuthorizeUrl, DEFAULT_OAUTH_REDIRECT_URI, generatePkcePair, redirectListenPort } from "./oauth.js";
import { oauthClientConfigFromEnv, JiraOAuthSession } from "./oauthSession.js";
import { clearTokenStore, tokenStorePath } from "./tokenStore.js";

export interface JiraLoginOptions {
  redirectUri?: string;
  siteUrl?: string;
  openBrowser?: boolean;
  importAccessToken?: string;
  fetchImpl?: typeof fetch;
}

export interface JiraLoginResult {
  storePath: string;
  cloudId: string;
  siteUrl: string;
  hasRefreshToken: boolean;
  expiresAt: number;
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><p>${body}</p></body></html>`;
}

function openInBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}

export async function runJiraLogin(options: JiraLoginOptions = {}): Promise<JiraLoginResult> {
  const config = oauthClientConfigFromEnv();
  const siteUrl = options.siteUrl ?? process.env.RELEASE_OPERATOR_JIRA_SITE;
  const cloudId = process.env.RELEASE_OPERATOR_JIRA_CLOUD_ID;
  const session = new JiraOAuthSession({ ...config, fetchImpl: options.fetchImpl, storePath: tokenStorePath() });

  if (options.importAccessToken) {
    const tokens = await session.importAccessToken({
      accessToken: options.importAccessToken,
      siteUrl,
      cloudId,
    });
    return {
      storePath: tokenStorePath(),
      cloudId: tokens.cloudId ?? "",
      siteUrl: tokens.siteUrl ?? "",
      hasRefreshToken: Boolean(tokens.refreshToken),
      expiresAt: tokens.expiresAt,
    };
  }

  if (!config) {
    throw new JiraServiceError(
      "Set RELEASE_OPERATOR_JIRA_OAUTH_CLIENT_ID and RELEASE_OPERATOR_JIRA_OAUTH_CLIENT_SECRET " +
        "(from the Atlassian developer console) before running jira login."
    );
  }
  for (const warning of config.warnings) {
    console.error(`warning: ${warning}`);
  }

  const redirectUri = options.redirectUri ?? process.env.RELEASE_OPERATOR_JIRA_OAUTH_REDIRECT_URI ?? DEFAULT_OAUTH_REDIRECT_URI;
  const state = randomBytes(16).toString("hex");
  const pkce = generatePkcePair();
  const authorizeUrl = buildAuthorizeUrl({
    clientId: config.clientId,
    redirectUri,
    state,
    codeChallenge: pkce.challenge,
  });

  const code = await waitForAuthorizationCode({
    redirectUri,
    expectedState: state,
    authorizeUrl,
    openBrowser: options.openBrowser !== false,
  });

  const tokens = await session.completeAuthorizationCode({
    code,
    redirectUri,
    siteUrl,
    cloudId,
    codeVerifier: pkce.verifier,
  });
  return {
    storePath: tokenStorePath(),
    cloudId: tokens.cloudId ?? "",
    siteUrl: tokens.siteUrl ?? "",
    hasRefreshToken: Boolean(tokens.refreshToken),
    expiresAt: tokens.expiresAt,
  };
}

export function runJiraLogout(): string {
  const path = tokenStorePath();
  clearTokenStore(path);
  return path;
}

function waitForAuthorizationCode(input: {
  redirectUri: string;
  expectedState: string;
  authorizeUrl: string;
  openBrowser: boolean;
}): Promise<string> {
  const port = redirectListenPort(input.redirectUri);
  const callbackPath = new URL(input.redirectUri).pathname || "/callback";

  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void handleRequest(req, res);
    });

    const timeout = setTimeout(() => {
      server.close();
      reject(new JiraServiceError("Timed out waiting for the Atlassian OAuth callback (5 minutes)"));
    }, 5 * 60_000);

    async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
      try {
        const host = req.headers.host ?? `127.0.0.1:${port}`;
        const url = new URL(req.url ?? "/", `http://${host}`);
        if (url.pathname !== callbackPath) {
          res.writeHead(404, { "Content-Type": "text/html" });
          res.end(htmlPage("Not found", "Unexpected path."));
          return;
        }
        const error = url.searchParams.get("error");
        if (error) {
          const description = url.searchParams.get("error_description") ?? error;
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(htmlPage("Authorization failed", `Atlassian returned: ${description}`));
          cleanup();
          reject(new JiraServiceError(`Atlassian authorization failed: ${description}`));
          return;
        }
        const returnedState = url.searchParams.get("state");
        if (returnedState !== input.expectedState) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(htmlPage("Authorization failed", "State mismatch. Restart jira login."));
          cleanup();
          reject(new JiraServiceError("OAuth state mismatch — restart jira login"));
          return;
        }
        const code = url.searchParams.get("code");
        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(htmlPage("Authorization failed", "No authorization code in the callback."));
          cleanup();
          reject(new JiraServiceError("OAuth callback had no code"));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(htmlPage("Connected", "Jira authorization complete. You can close this tab and return to the terminal."));
        cleanup();
        resolve(code);
      } catch (err) {
        cleanup();
        reject(err);
      }
    }

    function cleanup(): void {
      clearTimeout(timeout);
      server.close();
    }

    server.on("error", (err) => {
      cleanup();
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        reject(
          new JiraServiceError(
            `Port ${port} is already in use, so the OAuth callback cannot listen on ${input.redirectUri}. ` +
              `If something other than jira login is on 8080, stop it. mlx_lm.server should be on 8081 ` +
              `(\`npm run mlx:serve\`).`
          )
        );
        return;
      }
      reject(err);
    });

    server.listen(port, "127.0.0.1", () => {
      console.error(`Listening for Atlassian OAuth callback on ${input.redirectUri}`);
      console.error(`Open this URL if the browser does not launch:\n${input.authorizeUrl}`);
      if (input.openBrowser) {
        try {
          openInBrowser(input.authorizeUrl);
        } catch {
          // printed the URL above
        }
      }
    });
  });
}
