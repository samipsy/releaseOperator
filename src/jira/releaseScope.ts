import type { Release } from "../types.js";
import { githubPullRequestUrlFromCreate } from "../github/prUrl.js";
import type { GithubAssociatedPullRequest, GithubProvider } from "../github/types.js";
import { releasePrBase } from "../github/releaseBranches.js";
import type { IntelligenceProvider, CommitInfo } from "../intelligence/types.js";
import { ticketKeysFromText, uniqueTicketKeys } from "../intelligence/ticketKeys.js";
import {
  formatReleaseNotesBlock,
  type ReleaseChange,
} from "../releaseNotes.js";
import type { JiraIssueSummary, JiraProvider } from "./types.js";

export interface ReleaseTicketScope {
  commits: CommitInfo[];
  tickets: JiraIssueSummary[];
  changes: ReleaseChange[];
  /** Lines like `[APPS-123] Fix checkout by @sam in #88` — reuse for the PCM ticket. */
  releaseNotes: string;
  context: string;
}

function resolveOwner(repo: { owner?: string }, defaultGithubOrg?: string): string | undefined {
  return repo.owner ?? defaultGithubOrg;
}

/**
 * Commits on the release branch that are not on the merge target (usually main).
 * If that compare is empty (branch just cut from the target), falls back to latest tag...head.
 */
export async function commitsForReleaseRepo(
  github: GithubProvider,
  input: { owner: string; repo: string; sourceBranch: string; releaseBranch: string }
): Promise<CommitInfo[]> {
  let commits = await github.listCommitsAhead({
    owner: input.owner,
    repo: input.repo,
    base: input.sourceBranch,
    head: input.releaseBranch,
  });
  if (commits.length > 0) return commits;

  const tag = await github.latestTagName({ owner: input.owner, repo: input.repo });
  if (!tag || tag === input.releaseBranch) return [];
  return github.listCommitsAhead({
    owner: input.owner,
    repo: input.repo,
    base: tag,
    head: input.releaseBranch,
  });
}

async function changesForCommits(
  github: GithubProvider,
  input: { owner: string; repo: string; commits: CommitInfo[] }
): Promise<ReleaseChange[]> {
  const seenPrs = new Set<number>();
  const changes: ReleaseChange[] = [];
  for (const commit of input.commits) {
    let pulls: GithubAssociatedPullRequest[] = [];
    try {
      pulls = await github.listPullRequestsForCommit({
        owner: input.owner,
        repo: input.repo,
        sha: commit.sha,
      });
    } catch (err) {
      console.error(
        `[action:error] github.listPullRequestsForCommit ${input.owner}/${input.repo}@${commit.sha.slice(0, 8)}:`,
        (err as Error).message
      );
    }
    const pr = pulls[0];
    if (pr && seenPrs.has(pr.number)) continue;
    if (pr) seenPrs.add(pr.number);

    const blob = [commit.message, pr?.title ?? ""].join("\n");
    const ticketKey = ticketKeysFromText(blob)[0];
    const title = (pr?.title || commit.message.split("\n")[0] || "").trim();
    changes.push({
      ...(ticketKey ? { ticketKey } : {}),
      title,
      ...(pr?.userLogin || commit.author
        ? { author: pr?.userLogin ?? commit.author }
        : {}),
      ...(typeof pr?.number === "number"
        ? {
            prNumber: pr.number,
            prUrl:
              pr.htmlUrl ??
              githubPullRequestUrlFromCreate({
                owner: input.owner,
                repo: input.repo,
                number: pr.number,
              }),
          }
        : {}),
    });
  }
  return changes;
}

export async function collectReleaseTicketScope(options: {
  release: Release;
  github?: GithubProvider;
  jira?: JiraProvider;
  intelligence?: IntelligenceProvider;
  defaultGithubOrg?: string;
}): Promise<ReleaseTicketScope> {
  const commits: CommitInfo[] = [];
  const changes: ReleaseChange[] = [];
  if (options.github) {
    for (const repo of options.release.repos) {
      if (!repo.releaseBranch) continue;
      const owner = resolveOwner(repo, options.defaultGithubOrg);
      if (!owner) continue;
      try {
        const found = await commitsForReleaseRepo(options.github, {
          owner,
          repo: repo.name,
          sourceBranch: releasePrBase(repo),
          releaseBranch: repo.releaseBranch,
        });
        commits.push(...found);
        changes.push(...(await changesForCommits(options.github, { owner, repo: repo.name, commits: found })));
      } catch (err) {
        console.error(
          `[action:error] github.compare ${owner}/${repo.name} ${releasePrBase(repo)}...${repo.releaseBranch}:`,
          (err as Error).message
        );
      }
    }
  }

  let keys: string[] = uniqueTicketKeys([
    ...changes.flatMap((c) => (c.ticketKey ? [c.ticketKey] : [])),
    ...commits.flatMap((c) => ticketKeysFromText(c.message)),
  ]);
  if (options.intelligence && commits.length > 0) {
    try {
      const parsed = await options.intelligence.extractTicketKeys({ commits });
      keys = uniqueTicketKeys([...parsed, ...keys]);
    } catch (err) {
      console.error(`[action:error] intelligence.extractTicketKeys:`, (err as Error).message);
    }
  }

  const tickets: JiraIssueSummary[] = [];
  if (options.jira) {
    for (const key of keys) {
      try {
        tickets.push(await options.jira.getIssue(key));
      } catch (err) {
        console.error(`[action:error] jira.getIssue ${key}:`, (err as Error).message);
        tickets.push({ key, summary: "(could not load issue from Jira)" });
      }
    }
  } else {
    for (const key of keys) tickets.push({ key, summary: "(Jira not configured — key from commit only)" });
  }

  const summaryByKey = new Map(tickets.map((t) => [t.key, t.summary]));
  const urlByKey = new Map(tickets.flatMap((t) => (t.url ? [[t.key, t.url] as const] : [])));
  for (const change of changes) {
    if (!change.ticketKey) continue;
    const jiraTitle = summaryByKey.get(change.ticketKey);
    if (jiraTitle && !jiraTitle.startsWith("(")) {
      change.title = jiraTitle;
    }
    const ticketUrl = urlByKey.get(change.ticketKey);
    if (ticketUrl) change.ticketUrl = ticketUrl;
  }

  const releaseNotes = formatReleaseNotesBlock(changes);
  const commitLines = commits.map((c) => `- ${c.sha.slice(0, 8)} ${c.message.split("\n")[0]}`);
  const ticketLines = tickets.map((t) => {
    const brief = t.description ? ` — ${t.description}` : "";
    return `- ${t.key}: ${t.summary}${brief}`;
  });
  const context = [
    releaseNotes,
    commitLines.length > 0 ? `Commits vs merge target / last tag:\n${commitLines.join("\n")}` : "",
    ticketLines.length > 0 ? `Tickets:\n${ticketLines.join("\n")}` : "",
  ]
    .filter((block) => block.length > 0)
    .join("\n\n");

  return { commits, tickets, changes, releaseNotes, context };
}
