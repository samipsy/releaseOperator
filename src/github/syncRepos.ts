import { connectGithubMcp } from "./mcpClient.js";
import { listOrgRepositories } from "./listOrgRepos.js";
import { mergeSyncedCatalog, readRepoCatalog, writeRepoCatalog, type RepoCatalog } from "./repoCatalog.js";

export async function syncOrgRepoCatalog(options?: { org?: string; token?: string }): Promise<RepoCatalog> {
  const org = options?.org ?? process.env.RELEASE_OPERATOR_GITHUB_ORG;
  const token = options?.token ?? process.env.RELEASE_OPERATOR_GITHUB_TOKEN;
  if (!org) {
    throw new Error("RELEASE_OPERATOR_GITHUB_ORG is not set — cannot sync org repositories.");
  }
  if (!token) {
    throw new Error("RELEASE_OPERATOR_GITHUB_TOKEN is not set — cannot sync org repositories.");
  }

  const connection = await connectGithubMcp({ token, url: process.env.RELEASE_OPERATOR_GITHUB_MCP_URL });
  try {
    const repos = await listOrgRepositories({ org, caller: connection.caller, token });
    const catalog = mergeSyncedCatalog(org, repos, readRepoCatalog());
    writeRepoCatalog(catalog);
    return catalog;
  } finally {
    await connection.close();
  }
}
