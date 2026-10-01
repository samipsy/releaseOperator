/** Best-effort PR URL from create_pull_request MCP/REST output. */
export function githubPullRequestUrlFromCreate(options: {
  owner: string;
  repo: string;
  url?: string;
  number?: number;
  raw?: string;
}): string | undefined {
  if (options.url) {
    if (parseGithubPullRequestUrl(options.url)) return options.url;
    const apiMatch = options.url.match(/\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)/);
    if (apiMatch) return `https://github.com/${options.owner}/${options.repo}/pull/${apiMatch[1]}`;
  }
  if (typeof options.number === "number" && Number.isInteger(options.number) && options.number > 0) {
    return `https://github.com/${options.owner}/${options.repo}/pull/${options.number}`;
  }
  if (!options.raw) return undefined;
  try {
    const rec = JSON.parse(options.raw) as Record<string, unknown>;
    const html = typeof rec.html_url === "string" ? rec.html_url : undefined;
    if (html && parseGithubPullRequestUrl(html)) return html;
    const n = rec.number;
    if (typeof n === "number" && Number.isInteger(n) && n > 0) {
      return `https://github.com/${options.owner}/${options.repo}/pull/${n}`;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function parseGithubPullRequestUrl(
  url: string
): { owner: string; repo: string; number: number } | undefined {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
    if (!match) return undefined;
    const number = Number(match[3]);
    if (!Number.isInteger(number) || number <= 0) return undefined;
    return { owner: match[1], repo: match[2], number };
  } catch {
    return undefined;
  }
}
