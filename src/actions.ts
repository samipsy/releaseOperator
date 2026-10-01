import type { Action, Release, ReleaseEvent, ReleaseRepo, ReleaseState } from "./types.js";
import type { GithubProvider } from "./github/types.js";
import type { IntelligenceProvider } from "./intelligence/types.js";
import type { JiraProvider } from "./jira/types.js";
import type { SlackProvider } from "./slack/types.js";
import { collectReleaseTicketScope } from "./jira/releaseScope.js";
import { fillReleasePrBody, loadReleasePrTemplate, applyReleaseTicketToPrBody } from "./github/prTemplate.js";
import { githubPullRequestUrlFromCreate, parseGithubPullRequestUrl } from "./github/prUrl.js";
import { releasePrBase, backmergePrHead, backmergePrBase } from "./github/releaseBranches.js";
import { commitPackageJsonBump } from "./github/bumpPackageJson.js";
import {
  buildPcmChangeFields,
  changeReasonOneLiner,
  formatPcmTicketDescription,
  pcmImplementationPlan,
  pcmLinkedTicketKeys,
  PCM_ISSUE_LINK_TYPE,
} from "./jira/pcmChangeFields.js";
import { netlifyProjectsForRepos } from "./netlify/repoProjects.js";
import { watchBranchDeploys } from "./netlify/watchDeploys.js";
import { resolvePcmRollbackPlan } from "./netlify/rollbackPlan.js";
import type { NetlifyProvider } from "./netlify/types.js";
import { PREPROD_SOURCE_BRANCH, PREPROD_TARGET_BRANCH } from "./preprod/constants.js";

/**
 * Stub integrations. Each logs what it *would* do. Swap the body for a real
 * Slack/Jira/deploy/test call without touching the engine or transition table.
 * GitHub is already wired for real — see createReleaseBranchesAction / createBackmergePrAction
 * / tagRepositoriesOnGithubAction below.
 */
function log(label: string, release: Release, detail?: Record<string, unknown>) {
  // stderr, not stdout — stdout is reserved for the CLI's JSON result so scripts can pipe it.
  console.error(`[action:stub] ${label} release=${release.id} v${release.version}`, detail ?? "");
}

function logError(label: string, release: Release, err: unknown) {
  console.error(`[action:error] ${label} release=${release.id}:`, (err as Error).message ?? err);
}

export interface ActionDeps {
  github?: GithubProvider;
  /** Used when a ReleaseRepo has no owner set. */
  defaultGithubOrg?: string;
  /**
   * Strictly advisory: used only to draft text for a human to review (ticket descriptions,
   * release notes). Never consulted for any decision — nothing here can affect which
   * transitions are legal or how guards evaluate. See src/intelligence/types.ts.
   */
  intelligence?: IntelligenceProvider;
  jira?: JiraProvider;
  /** Jira project key for created tickets, e.g. "PCM". Required for real ticket creation. */
  jiraProjectKey?: string;
  /** Jira issue type name, e.g. "Task" — defaults to "Task" if unset. */
  jiraIssueType?: string;
  /** Parent Epic/issue key required by some Jira projects. */
  jiraParentKey?: string;
  /** Extra Jira fields (customfield_*, labels, …). */
  jiraExtraFields?: Record<string, unknown>;
  slack?: SlackProvider;
  /** Channel id (`C…`) or `#name`. Required for real Slack posts. */
  slackChannel?: string;
  /** Looks up live Netlify deploys for PCM rollback when `NETLIFY_AUTH_TOKEN` is set. */
  netlify?: NetlifyProvider;
  /** Overrides for pre-prod Netlify polling (tests). */
  netlifyPoll?: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> };
}

function resolveOwner(repo: ReleaseRepo, deps: ActionDeps): string | undefined {
  return repo.owner ?? deps.defaultGithubOrg;
}

function releaseSlackSummary(release: Release): string {
  const ticket = release.ticket?.url ?? release.ticket?.id;
  const ticketLine = ticket ? `\nTicket: ${ticket}` : "";
  return `Release ${release.version} (${release.environment}) id \`${release.id}\`${ticketLine}`;
}

function storedApprovalThread(release: Release): { channel: string; ts: string } | undefined {
  const slots = [release.approvals.preprod, release.approvals.cab, release.approvals.qa];
  for (const slot of slots) {
    const channel = slot?.slackChannel?.trim();
    const ts = slot?.slackTs?.trim();
    if (channel && ts) return { channel, ts };
  }
  return undefined;
}

async function postSlack(
  deps: ActionDeps,
  release: Release,
  label: string,
  text: string,
  threadTs?: string
): Promise<{ channel: string; ts: string; url?: string } | undefined> {
  if (!deps.slack) {
    log(`${label} (skipped: Slack integration not configured)`, release);
    return undefined;
  }
  const thread = storedApprovalThread(release);
  const channel = (threadTs ? thread?.channel : undefined) ?? deps.slackChannel?.trim();
  if (!channel) {
    console.error(`[action:error] ${label}: RELEASE_OPERATOR_SLACK_CHANNEL is unset`);
    return undefined;
  }
  try {
    const result = await deps.slack.postMessage({
      channel,
      text,
      ...(threadTs ? { threadTs } : {}),
    });
    log(label, release, { channel: result.channel, ts: result.ts, url: result.url, threadTs });
    console.error(`[action] Slack ${label}: ${result.url ?? `${result.channel} ${result.ts}`}`);
    return result;
  } catch (err) {
    logError(label, release, err);
    return undefined;
  }
}

async function replyInApprovalThread(
  deps: ActionDeps,
  release: Release,
  label: string,
  text: string
): Promise<void> {
  const thread = storedApprovalThread(release);
  if (!thread) {
    log(`${label} (skipped: no Slack approval thread stored)`, release);
    return;
  }
  await postSlack(deps, release, label, text, thread.ts);
}

function notifySlack(deps: ActionDeps, label: string, text: (release: Release) => string): Action {
  return async (release: Release) => {
    const thread = storedApprovalThread(release);
    if (thread) {
      await replyInApprovalThread(deps, release, label, text(release));
      return;
    }
    await postSlack(deps, release, label, text(release));
  };
}

/** Fires for real on entering BRANCH_CREATED: the release event's payload already set releaseBranch. */
function createReleaseBranchesAction(deps: ActionDeps): Action {
  return async (release: Release) => {
    if (!deps.github) {
      log("github.createReleaseBranches (skipped: GitHub integration not configured)", release, {
        repos: release.repos.map((r) => r.name),
      });
      return;
    }
    for (const repo of release.repos) {
      if (!repo.releaseBranch) continue;
      const owner = resolveOwner(repo, deps);
      if (!owner) {
        console.error(
          `[action:error] github.createReleaseBranch: repo "${repo.name}" has no owner and RELEASE_OPERATOR_GITHUB_ORG is unset`
        );
        continue;
      }
      try {
        const result = await deps.github.createReleaseBranch({
          owner,
          repo: repo.name,
          branch: repo.releaseBranch,
          fromBranch: repo.sourceBranch,
        });
        log("github.createReleaseBranch", release, {
          repo: `${owner}/${repo.name}`,
          branch: repo.releaseBranch,
          result: result.ref ?? result.raw,
        });
      } catch (err) {
        logError(`github.createReleaseBranch (${owner}/${repo.name})`, release, err);
      }
      try {
        const bumped = await commitPackageJsonBump({
          github: deps.github,
          owner,
          repo: repo.name,
          branch: repo.releaseBranch,
          version: release.version,
          packageJsonPath: repo.packageJsonPath,
        });
        if (!bumped) {
          console.error(
            `[action:error] github.bumpPackageJson (${owner}/${repo.name}@${repo.releaseBranch}): no app/package.json or package.json found`
          );
        } else if (bumped.skipped) {
          log("github.bumpPackageJson", release, {
            repo: `${owner}/${repo.name}`,
            path: bumped.path,
            version: release.version,
            note: "already at release version",
          });
        } else {
          log("github.bumpPackageJson", release, {
            repo: `${owner}/${repo.name}`,
            path: bumped.path,
            from: bumped.previous,
            to: release.version,
          });
          console.error(
            `[action] Bumped ${bumped.path} ${bumped.previous ?? "?"} → ${release.version} on ${owner}/${repo.name}@${repo.releaseBranch}`
          );
        }
      } catch (err) {
        logError(`github.bumpPackageJson (${owner}/${repo.name})`, release, err);
      }
    }
  };
}

/**
 * Fires on entering RELEASE_PR_PENDING: opens a PR from the release branch into main (source
 * branch), using the repo's release pull-request template when one exists.
 */
function createReleasePrAction(deps: ActionDeps): Action {
  return async (release: Release) => {
    if (!deps.github) {
      log("github.createReleasePr (skipped: GitHub integration not configured)", release, {
        repos: release.repos.map((r) => r.name),
      });
      return;
    }

    const scope = await collectReleaseTicketScope({
      release,
      github: deps.github,
      jira: deps.jira,
      intelligence: deps.intelligence,
      defaultGithubOrg: deps.defaultGithubOrg,
    });

    const prUrls: Record<string, string> = {};
    for (const repo of release.repos) {
      if (!repo.releaseBranch) continue;
      const owner = resolveOwner(repo, deps);
      if (!owner) {
        console.error(
          `[action:error] github.createReleasePr: repo "${repo.name}" has no owner and RELEASE_OPERATOR_GITHUB_ORG is unset`
        );
        continue;
      }
      try {
        let template: string | undefined;
        let templatePath: string | undefined;
        try {
          const loaded = await loadReleasePrTemplate(deps.github, {
            owner,
            repo: repo.name,
            ref: repo.releaseBranch,
          });
          template = loaded?.text;
          templatePath = loaded?.path;
        } catch (err) {
          console.error(
            `[action:error] github.releasePrTemplate (${owner}/${repo.name}):`,
            (err as Error).message
          );
        }

        const base = releasePrBase(repo);
        const body = fillReleasePrBody({
          template,
          version: release.version,
          environment: release.environment,
          repo: repo.name,
          head: repo.releaseBranch,
          base,
          releaseNotes: scope.releaseNotes,
        });
        const result = await deps.github.createBackmergePullRequest({
          owner,
          repo: repo.name,
          title: `Release ${release.version}`,
          head: repo.releaseBranch,
          base,
          body,
        });
        const prUrl = githubPullRequestUrlFromCreate({
          owner,
          repo: repo.name,
          url: result.url,
          number: result.number,
          raw: result.raw,
        });
        if (prUrl) prUrls[repo.name] = prUrl;
        log("github.createReleasePr", release, {
          repo: `${owner}/${repo.name}`,
          url: prUrl ?? result.raw,
          template: templatePath ?? "(none)",
        });
        console.error(
          `[action] Release PR for ${owner}/${repo.name}: ${prUrl ?? result.raw}` +
            (templatePath ? ` (template ${templatePath})` : " (no release PR template found in repo)")
        );
      } catch (err) {
        logError(`github.createReleasePr (${owner}/${repo.name})`, release, err);
      }
    }

    if (Object.keys(prUrls).length > 0) {
      release.repos = release.repos.map((repo) => ({
        ...repo,
        ...(prUrls[repo.name] ? { releasePrUrl: prUrls[repo.name] } : {}),
      }));
    }
  };
}

function githubApiRepoName(repo: ReleaseRepo): string {
  const fromUrl = repo.url?.match(/github\.com\/[^/]+\/([^/.]+)/i);
  if (fromUrl?.[1]) return fromUrl[1];
  return repo.name;
}

function requestApproval(deps: ActionDeps, kind: "qa" | "cab" | "preprod"): Action {
  return async (release: Release) => {
    const label =
      kind === "qa"
        ? "slack.sendQaApprovalMessage"
        : kind === "cab"
          ? "slack.sendCabApprovalMessage"
          : "slack.sendPreprodApprovalMessage";
    const who = kind === "qa" ? "QA" : kind === "cab" ? "CAB" : "pre-prod sync";
    const preprodPrUrls = release.repos
      .map((repo) => repo.releasePrUrl?.trim())
      .filter((url): url is string => Boolean(url));
    const how =
      kind === "preprod"
        ? [
            "Hey team, Please review this PR to sync pre-prod-1 branch from develop: " +
              `${preprodPrUrls.length > 0 ? preprodPrUrls.join(" ") : "(PR URL missing)"}. Thanks.`,
          ]
        : [
            `${releaseSlackSummary(release)} needs ${who} approval.`,
            "Reply *approve* / *approved* / *approval* or ✅ in this thread.",
            `Then: npm run cli -- slack ingest-approvals ${release.id}`,
          ];
    const posted = await postSlack(deps, release, label, how.join("\n"));
    if (!posted) return;
    if (kind === "qa") {
      release.approvals.qa = {
        ...release.approvals.qa,
        status: release.approvals.qa?.status ?? "pending",
        slackChannel: posted.channel,
        slackTs: posted.ts,
      };
    } else if (kind === "cab") {
      release.approvals.cab = {
        ...release.approvals.cab,
        status: release.approvals.cab?.status ?? "pending",
        slackChannel: posted.channel,
        slackTs: posted.ts,
      };
    } else {
      release.approvals.preprod = {
        ...release.approvals.preprod,
        status: release.approvals.preprod?.status ?? "pending",
        slackChannel: posted.channel,
        slackTs: posted.ts,
      };
    }
  };
}

/**
 * Fires for real on entering TICKET_CREATE_PENDING — after the release PR is open. Drafts a
 * description via the SLM first (if configured) for stderr review, then creates the PCM
 * Change with the standard why / tickets / env / systems description.
 */
function createChangeTicketAction(deps: ActionDeps): Action {
  return async (release: Release) => {
    const scope = await collectReleaseTicketScope({
      release,
      github: deps.github,
      jira: deps.jira,
      intelligence: deps.intelligence,
      defaultGithubOrg: deps.defaultGithubOrg,
    });
    if (scope.commits.length > 0 || scope.tickets.length > 0) {
      console.error(
        `[action] Release scope for ${release.version}: ${scope.commits.length} commit(s), ${scope.tickets.length} ticket(s)`
      );
    }

    if (deps.intelligence) {
      try {
        const drafted = await deps.intelligence.generateTicketDescription({
          release,
          context: scope.context || undefined,
          tickets: scope.tickets,
        });
        console.error(
          `[action] SLM-drafted ticket description for release ${release.version} — VERIFY before use:\n${drafted}`
        );
      } catch (err) {
        logError("intelligence.generateTicketDescription", release, err);
      }
    }

    const repo = release.repos[0]?.name ?? "repo";
    const tableChanges =
      scope.changes.length > 0
        ? scope.changes
        : scope.tickets.map((ticket) => ({
            ticketKey: ticket.key,
            ...(ticket.url ? { ticketUrl: ticket.url } : {}),
            title: ticket.summary,
          }));
    const description = formatPcmTicketDescription({
      version: release.version,
      repo,
      changes: tableChanges,
    });

    if (!deps.jira) {
      log("jira.createChangeTicket (skipped: Jira integration not configured)", release);
      return;
    }
    const jira = deps.jira;
    if (!deps.jiraProjectKey) {
      console.error(`[action:error] jira.createChangeTicket: RELEASE_OPERATOR_JIRA_PROJECT_KEY is unset`);
      return;
    }
    if (!release.plannedStart || !release.plannedEnd) {
      console.error(
        `[action:error] jira.createChangeTicket: planned start/end are required. Re-create with prompts, or retry with --payload '{"plannedStart":"2026-10-02 10:00","plannedEnd":"2026-10-02 11:00"}'`
      );
      return;
    }

    let accountId: string | undefined;
    if (jira.getMyself) {
      try {
        accountId = (await jira.getMyself()).accountId;
      } catch (err) {
        logError("jira.getMyself", release, err);
      }
    }

    const implementation = pcmImplementationPlan(release);
    if (!implementation) {
      console.error(
        `[action:error] jira.createChangeTicket: Implementation plan needs the release PR URL on the release record.`
      );
      return;
    }

    const bump = release.bump ?? "patch";
    const summary = changeReasonOneLiner({ bump, repo, version: release.version });
    const rollbackPlan = await resolvePcmRollbackPlan(release, deps.netlify);
    console.error(`[action] PCM rollback plan:\n${rollbackPlan}`);
    const extraFields = {
      ...buildPcmChangeFields(release, { accountId, rollbackPlan }),
      ...(deps.jiraExtraFields ?? {}),
    };

    try {
      const result = await jira.createIssue({
        projectKey: deps.jiraProjectKey,
        summary,
        issueType: deps.jiraIssueType ?? "Task",
        description,
        parentKey: deps.jiraParentKey,
        extraFields,
      });
      const key = result.key ?? "(unknown key)";
      if (result.key) {
        release.ticket = { id: result.key, ...(result.url ? { url: result.url } : {}) };
        if (jira.createIssueLink) {
          const pcmKey = result.key.toUpperCase();
          for (const related of pcmLinkedTicketKeys(tableChanges)) {
            if (related === pcmKey) continue;
            try {
              await jira.createIssueLink({
                inwardIssue: related,
                outwardIssue: result.key,
                type: PCM_ISSUE_LINK_TYPE,
              });
            } catch (err) {
              logError(`jira.createIssueLink ${result.key} Relates ${related}`, release, err);
            }
          }
        }
      }
      log("jira.createChangeTicket", release, { key, url: result.url });
      console.error(`[action] Jira ticket for release ${release.version}: ${key} — ${result.url ?? result.raw}`);
    } catch (err) {
      logError("jira.createChangeTicket", release, err);
    }
  };
}

/**
 * Fires on entering CHANGE_TICKET_CREATED: the PCM ticket is now on the record, so patch each
 * release PR description with that key (placeholders like PCM-XXXX, or a new Ticket section).
 */
function updateReleasePrsWithTicketAction(deps: ActionDeps): Action {
  return async (release: Release) => {
    const ticketId = release.ticket?.id?.trim();
    if (!ticketId) {
      log("github.updateReleasePrTicket (skipped: no ticket id on record)", release);
      return;
    }
    if (!deps.github) {
      log("github.updateReleasePrTicket (skipped: GitHub integration not configured)", release);
      return;
    }

    for (const repo of release.repos) {
      if (!repo.releasePrUrl) continue;
      const parsed = parseGithubPullRequestUrl(repo.releasePrUrl);
      const owner = parsed?.owner ?? resolveOwner(repo, deps);
      if (!parsed || !owner) {
        console.error(
          `[action:error] github.updateReleasePrTicket: cannot parse pull request URL for repo "${repo.name}": ${repo.releasePrUrl}`
        );
        continue;
      }
      try {
        const current = await deps.github.getPullRequest({
          owner,
          repo: repo.name,
          pullNumber: parsed.number,
        });
        const next = applyReleaseTicketToPrBody(current.body ?? "", {
          id: ticketId,
          url: release.ticket?.url,
        });
        if (next === (current.body ?? "")) {
          log("github.updateReleasePrTicket", release, {
            repo: `${owner}/${repo.name}`,
            pull: parsed.number,
            note: "PR body already contains the release ticket",
          });
          continue;
        }
        const result = await deps.github.updatePullRequest({
          owner,
          repo: repo.name,
          pullNumber: parsed.number,
          body: next,
        });
        log("github.updateReleasePrTicket", release, {
          repo: `${owner}/${repo.name}`,
          pull: parsed.number,
          ticket: ticketId,
          url: result.url ?? repo.releasePrUrl,
        });
        console.error(
          `[action] Updated release PR for ${owner}/${repo.name}#${parsed.number} with ticket ${ticketId}`
        );
      } catch (err) {
        logError(`github.updateReleasePrTicket (${owner}/${repo.name})`, release, err);
      }
    }
  };
}

async function triggerDeployment(release: Release): Promise<void> {
  log("deploy.trigger", release, { deploymentId: release.deployment?.deploymentId });
}

async function runSanityChecks(release: Release): Promise<void> {
  log("test.runSanityChecks", release);
}

/**
 * Fires on entering FINALIZING. Drafts release notes via the SLM (if configured) and, if a
 * real ticket exists and Jira is configured, posts them as a comment on that ticket — an
 * update to the existing ticket via a comment rather than overwriting its description.
 */
function updateTicketOnFinalizeAction(deps: ActionDeps): Action {
  return async (release: Release) => {
    let notes: string | undefined;
    if (deps.intelligence) {
      try {
        notes = await deps.intelligence.generateReleaseNotes({ release });
        console.error(
          `[action] SLM-drafted release notes for ${release.version} — VERIFY before publishing, ` +
            `no real change context was given, specifics may be invented:\n${notes}`
        );
      } catch (err) {
        logError("intelligence.generateReleaseNotes", release, err);
      }
    }

    if (!deps.jira || !release.ticket?.id) {
      log("jira.updateTicket (skipped: Jira not configured or no ticket on record)", release, {
        ticket: release.ticket?.id,
      });
      return;
    }
    try {
      await deps.jira.addComment({
        issueKey: release.ticket.id,
        body: notes ?? `Release ${release.version} has reached finalizing.`,
      });
      log("jira.updateTicket", release, { ticket: release.ticket.id, note: "posted release notes comment" });
    } catch (err) {
      logError(`jira.updateTicket (${release.ticket.id})`, release, err);
    }
  };
}

/**
 * Fires for real on entering BACKMERGE_PENDING. Because github-mcp-server's create_pull_request
 * result is the real, final answer (not a "kickoff" we wait on separately), this prints the real
 * PR URL and the exact next CLI command to run — the operator still explicitly confirms via
 * BACKMERGE_CREATED (keeping the state machine's human-in-the-loop shape unchanged), but with
 * real data handed to them instead of needing to go find it.
 */
function waitForChangeAppliedAction(): Action {
  return async (release: Release) => {
    const ticket = release.ticket?.id ?? "(no ticket)";
    console.error(
      `[action] Waiting for PCM ${ticket} status "Change Applied".\n` +
        `  -> run: release-operator jira change-applied ${release.id} --by <you>\n` +
        `  -> or: release-operator event ${release.id} CHANGE_APPLIED --by <you>`
    );
  };
}

function createBackmergePrAction(deps: ActionDeps): Action {
  return async (release: Release) => {
    if (!deps.github) {
      log("github.createBackmergePr (skipped: GitHub integration not configured)", release, {
        repos: release.repos.map((r) => r.name),
      });
      return;
    }
    for (const repo of release.repos) {
      if (!repo.releaseBranch) continue;
      const owner = resolveOwner(repo, deps);
      if (!owner) {
        console.error(
          `[action:error] github.createBackmergePr: repo "${repo.name}" has no owner and RELEASE_OPERATOR_GITHUB_ORG is unset`
        );
        continue;
      }
      const head = backmergePrHead(repo);
      const base = backmergePrBase(repo);
      if (head === base) {
        console.error(
          `[action] github.createBackmergePr skipped for ${owner}/${repo.name}: source and target are both "${base}"`
        );
        continue;
      }
      try {
        const result = await deps.github.createBackmergePullRequest({
          owner,
          repo: repo.name,
          title: `Backmerge ${head} into ${base} (release ${release.version})`,
          head,
          base,
          body: `Automated backmerge of ${head} into ${base} after release ${release.version} was applied.`,
        });
        const prUrl = result.url ?? result.raw;
        log("github.createBackmergePr", release, { repo: `${owner}/${repo.name}`, url: prUrl });
        console.error(
          `[action] Backmerge PR for ${owner}/${repo.name}: ${prUrl}\n` +
            `  -> once merged, run: release-operator event ${release.id} BACKMERGE_CREATED --by <you> --payload '{"prUrl":${JSON.stringify(prUrl)}}'`
        );
      } catch (err) {
        logError(`github.createBackmergePr (${owner}/${repo.name})`, release, err);
      }
    }
  };
}

async function tagRepositories(release: Release): Promise<void> {
  log("github.tagRepositories (waiting on REPOS_TAGGED to report tag names)", release, {
    repos: release.repos.map((r) => r.name),
  });
}

/**
 * Fires for real on entering TAGGED — by then REPOS_TAGGED has already recorded the desired
 * tag name per repo on release.repos[].tag, so this is the earliest point real tagging is
 * possible. Resolves each repo's release-branch HEAD sha itself, then creates the tag ref.
 */
function tagRepositoriesOnGithubAction(deps: ActionDeps): Action {
  return async (release: Release) => {
    if (!deps.github) {
      log("github.tagRepositoriesOnGithub (skipped: GitHub integration not configured)", release, {
        repos: release.repos.map((r) => r.name),
      });
      return;
    }
    for (const repo of release.repos) {
      if (!repo.tag || !repo.releaseBranch) continue;
      const owner = resolveOwner(repo, deps);
      if (!owner) {
        console.error(
          `[action:error] github.tagReleaseBranch: repo "${repo.name}" has no owner and RELEASE_OPERATOR_GITHUB_ORG is unset`
        );
        continue;
      }
      try {
        const result = await deps.github.tagReleaseBranch({
          owner,
          repo: repo.name,
          branch: repo.releaseBranch,
          tag: repo.tag,
        });
        log("github.tagReleaseBranch", release, {
          repo: `${owner}/${repo.name}`,
          tag: repo.tag,
          result: result.ref ?? result.raw,
        });
      } catch (err) {
        logError(`github.tagReleaseBranch (${owner}/${repo.name})`, release, err);
      }
    }
  };
}

function createPreprodPrAction(deps: ActionDeps): Action {
  return async (release: Release) => {
    if (!deps.github) {
      log("github.createPreprodPr (skipped: GitHub integration not configured)", release);
      return;
    }
    const prUrls: Record<string, string> = {};
    for (const repo of release.repos) {
      const owner = resolveOwner(repo, deps);
      if (!owner) {
        console.error(
          `[action:error] github.createPreprodPr: repo "${repo.name}" has no owner and RELEASE_OPERATOR_GITHUB_ORG is unset`
        );
        continue;
      }
      const githubRepo = githubApiRepoName(repo);
      const head = repo.sourceBranch || PREPROD_SOURCE_BRANCH;
      const base = repo.targetBranch || PREPROD_TARGET_BRANCH;
      try {
        const result = await deps.github.createBackmergePullRequest({
          owner,
          repo: githubRepo,
          title: `Sync ${head} → ${base}`,
          head,
          base,
          body: `Pre-prod sync for \`${githubRepo}\`.\n\nMerge ${head} into ${base} after Slack approval.`,
        });
        const prUrl = githubPullRequestUrlFromCreate({
          owner,
          repo: githubRepo,
          url: result.url,
          number: result.number,
          raw: result.raw,
        });
        if (prUrl) prUrls[repo.name] = prUrl;
        log("github.createPreprodPr", release, { repo: `${owner}/${githubRepo}`, url: prUrl ?? result.raw, head, base });
        console.error(`[action] Pre-prod PR for ${owner}/${githubRepo}: ${prUrl ?? result.raw} (${head} → ${base})`);
      } catch (err) {
        logError(`github.createPreprodPr (${owner}/${githubRepo})`, release, err);
      }
    }
    if (Object.keys(prUrls).length > 0) {
      release.repos = release.repos.map((repo) => ({
        ...repo,
        ...(prUrls[repo.name] ? { releasePrUrl: prUrls[repo.name] } : {}),
      }));
    }
  };
}

function mergePreprodPrAction(deps: ActionDeps): Action {
  return async (release: Release) => {
    if (!deps.github?.mergePullRequest) {
      log("github.mergePreprodPr (skipped: GitHub merge not configured)", release);
      return;
    }
    const merge = deps.github.mergePullRequest;
    const mergedUrls: string[] = [];
    for (const repo of release.repos) {
      const parsed = repo.releasePrUrl ? parseGithubPullRequestUrl(repo.releasePrUrl) : undefined;
      if (!parsed) {
        console.error(`[action:error] github.mergePreprodPr: no PR URL on repo "${repo.name}"`);
        continue;
      }
      try {
        const result = await merge({
          owner: parsed.owner,
          repo: parsed.repo,
          pullNumber: parsed.number,
        });
        if (result.merged || result.sha) {
          release.deployment = {
            ...release.deployment,
            status: "pending",
            deploymentId: result.sha ?? String(parsed.number),
            startedAt: new Date(),
          };
          if (repo.releasePrUrl) mergedUrls.push(repo.releasePrUrl);
        }
        log("github.mergePreprodPr", release, {
          repo: `${parsed.owner}/${parsed.repo}`,
          number: parsed.number,
          sha: result.sha,
          merged: result.merged,
        });
        console.error(
          `[action] Merged ${parsed.owner}/${parsed.repo}#${parsed.number}` +
            (result.sha ? ` sha ${result.sha}` : "")
        );
      } catch (err) {
        logError(`github.mergePreprodPr (${parsed.owner}/${parsed.repo}#${parsed.number})`, release, err);
      }
    }
    if (mergedUrls.length > 0) {
      await replyInApprovalThread(
        deps,
        release,
        "slack.notifyPreprodMerged",
        [
          `${releaseSlackSummary(release)}: PR is now merged into pre-prod-1. Build is progressing.`,
          ...mergedUrls,
        ].join("\n")
      );
    }
  };
}

function watchPreprodNetlifyAction(deps: ActionDeps): Action {
  return async (release: Release) => {
    const branch = release.repos[0]?.targetBranch || PREPROD_TARGET_BRANCH;
    const sites = netlifyProjectsForRepos(release.repos.map((repo) => repo.name)).flatMap((pair) => [
      { region: pair.us.region, site: pair.us.site },
      { region: pair.mx.region, site: pair.mx.site },
    ]);
    if (sites.length === 0) {
      console.error(`[action] No Netlify US/MX mapping for this repo; marking pre-prod deploy complete.`);
      release.deployment = { ...release.deployment, status: "success", completedAt: new Date() };
      await replyInApprovalThread(
        deps,
        release,
        "slack.notifyPreprodBuildSucceeded",
        `${releaseSlackSummary(release)}: build was successful (no Netlify mapping for this repo).`
      );
      return;
    }
    if (!deps.netlify) {
      console.error(`[action:error] Netlify not configured (NETLIFY_AUTH_TOKEN). Cannot watch ${branch} deploys.`);
      console.error(`  -> run: release-operator event ${release.id} PREPROD_DEPLOY_FAILED`);
      return;
    }
    const startedAt = release.deployment?.startedAt ?? new Date();
    console.error(`[action] Watching Netlify ${branch} deploys for ${sites.map((s) => s.site).join(", ")}`);
    const result = await watchBranchDeploys({
      sites,
      branch,
      netlify: deps.netlify,
      startedAt,
      timeoutMs: deps.netlifyPoll?.timeoutMs,
      intervalMs: deps.netlifyPoll?.intervalMs,
      sleep: deps.netlifyPoll?.sleep,
    });
    if (result.ok) {
      release.deployment = {
        ...release.deployment,
        status: "success",
        completedAt: new Date(),
        deploymentId: result.deploys.map((d) => d.deploy.id).join(","),
      };
      for (const row of result.deploys) {
        console.error(`[action] ${row.region} ${row.site}: ${row.deploy.adminUrl}`);
      }
      await replyInApprovalThread(
        deps,
        release,
        "slack.notifyPreprodBuildSucceeded",
        [
          `${releaseSlackSummary(release)}: build was successful.`,
          ...result.deploys.map(
            (row) => `${row.region} ${row.site}: ${row.deploy.adminUrl ?? row.deploy.id}`
          ),
        ].join("\n")
      );
      return;
    }
    console.error(`[action:error] Netlify watch failed: ${result.reason}`);
    console.error(`  -> run: release-operator event ${release.id} PREPROD_DEPLOY_FAILED`);
    await replyInApprovalThread(
      deps,
      release,
      "slack.notifyPreprodBuildFailed",
      `${releaseSlackSummary(release)}: build failed. ${result.reason}`
    );
  };
}

/** Actions run on ENTERING a state (after the transition + guards have succeeded and been persisted). */
export function buildOnEnterRegistry(deps: ActionDeps = {}): Partial<Record<ReleaseState, Action[]>> {
  return {
    TICKET_CREATE_PENDING: [createChangeTicketAction(deps)],
    TICKET_CREATE_FAILED: [notifySlack(deps, "slack.notifyTicketCreateFailed", (r) => `${releaseSlackSummary(r)}: ticket create failed`)],
    CHANGE_TICKET_CREATED: [updateReleasePrsWithTicketAction(deps)],
    BRANCH_CREATED: [createReleaseBranchesAction(deps)],
    RELEASE_PR_PENDING: [createReleasePrAction(deps)],
    RELEASE_PR_FAILED: [notifySlack(deps, "slack.notifyReleasePrFailed", (r) => `${releaseSlackSummary(r)}: release PR failed`)],
    QA_APPROVAL_PENDING: [requestApproval(deps, "qa")],
    CAB_APPROVAL_PENDING: [requestApproval(deps, "cab")],
    READY_TO_DEPLOY: [notifySlack(deps, "slack.notifyReadyToDeploy", (r) => `${releaseSlackSummary(r)} is ready to deploy`)],
    DEPLOYING: [triggerDeployment],
    SANITY_CHECKING: [runSanityChecks],
    FINALIZING: [updateTicketOnFinalizeAction(deps)],
    TICKET_UPDATED: [waitForChangeAppliedAction()],
    TICKET_UPDATE_FAILED: [
      notifySlack(deps, "slack.notifyTicketUpdateFailed", (r) => `${releaseSlackSummary(r)}: ticket update failed`),
    ],
    BACKMERGE_PENDING: [createBackmergePrAction(deps)],
    BACKMERGE_FAILED: [notifySlack(deps, "slack.notifyBackmergeFailed", (r) => `${releaseSlackSummary(r)}: backmerge failed`)],
    TAGGING_PENDING: [tagRepositories],
    TAGGING_FAILED: [notifySlack(deps, "slack.notifyTaggingFailed", (r) => `${releaseSlackSummary(r)}: tagging failed`)],
    TAGGED: [tagRepositoriesOnGithubAction(deps)],
    PREPROD_PR_PENDING: [createPreprodPrAction(deps)],
    PREPROD_PR_FAILED: [notifySlack(deps, "slack.notifyPreprodPrFailed", (r) => `${releaseSlackSummary(r)}: pre-prod PR failed`)],
    PREPROD_APPROVAL_PENDING: [requestApproval(deps, "preprod")],
    PREPROD_MERGING: [mergePreprodPrAction(deps)],
    PREPROD_MERGE_FAILED: [notifySlack(deps, "slack.notifyPreprodMergeFailed", (r) => `${releaseSlackSummary(r)}: pre-prod merge failed`)],
    PREPROD_DEPLOYING: [watchPreprodNetlifyAction(deps)],
    PREPROD_DEPLOY_FAILED: [notifySlack(deps, "slack.notifyPreprodDeployFailed", (r) => `${releaseSlackSummary(r)}: pre-prod Netlify deploy failed`)],
    COMPLETE: [
      async (release) => {
        if (release.environment === "preprod") return;
        await notifySlack(deps, "slack.notifyComplete", (r) => `${releaseSlackSummary(r)} is complete`)(release);
      },
    ],
    BLOCKED: [notifySlack(deps, "slack.notifyBlocked", (r) => `${releaseSlackSummary(r)} is blocked`)],
    FAILED: [notifySlack(deps, "slack.notifyFailed", (r) => `${releaseSlackSummary(r)} failed`)],
    ROLLED_BACK: [notifySlack(deps, "slack.notifyRolledBack", (r) => `${releaseSlackSummary(r)} was rolled back`)],
    CANCELLED: [notifySlack(deps, "slack.notifyCancelled", (r) => `${releaseSlackSummary(r)} was cancelled`)],
  };
}

/**
 * Actions are best-effort side effects: a failure here is logged but never unwinds
 * a transition that has already been persisted. If an action must be able to block
 * the transition, it belongs in guards.ts instead, not here.
 */
export async function runActions(
  release: Release,
  event: ReleaseEvent,
  previousState: ReleaseState,
  registry: Partial<Record<ReleaseState, Action[]>>
): Promise<void> {
  const actions = registry[release.state];
  if (!actions || actions.length === 0) return;

  for (const action of actions) {
    try {
      await action(release, event, previousState);
    } catch (err) {
      console.error(`[action:error] state=${release.state} release=${release.id}`, err);
    }
  }
}
