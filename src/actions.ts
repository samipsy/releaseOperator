import type { Action, Release, ReleaseEvent, ReleaseRepo, ReleaseState } from "./types.js";
import type { GithubProvider } from "./github/types.js";

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
}

function resolveOwner(repo: ReleaseRepo, deps: ActionDeps): string | undefined {
  return repo.owner ?? deps.defaultGithubOrg;
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
    }
  };
}

async function createChangeTicket(release: Release): Promise<void> {
  log("jira.createChangeTicket", release, { ticket: release.ticket?.id });
}

async function sendQaApprovalMessage(release: Release): Promise<void> {
  log("slack.sendQaApprovalMessage", release);
}

async function sendCabApprovalMessage(release: Release): Promise<void> {
  log("slack.sendCabApprovalMessage", release);
}

async function notifyReadyToDeploy(release: Release): Promise<void> {
  log("slack.notifyReadyToDeploy", release);
}

async function triggerDeployment(release: Release): Promise<void> {
  log("deploy.trigger", release, { deploymentId: release.deployment?.deploymentId });
}

async function runSanityChecks(release: Release): Promise<void> {
  log("test.runSanityChecks", release);
}

async function updateTicketOnFinalize(release: Release): Promise<void> {
  log("jira.updateTicket", release, { ticket: release.ticket?.id, note: "release finalized" });
}

async function notifyTicketUpdateFailed(release: Release): Promise<void> {
  log("slack.notifyTicketUpdateFailed", release, { ticket: release.ticket?.id });
}

/**
 * Fires for real on entering BACKMERGE_PENDING. Because github-mcp-server's create_pull_request
 * result is the real, final answer (not a "kickoff" we wait on separately), this prints the real
 * PR URL and the exact next CLI command to run — the operator still explicitly confirms via
 * BACKMERGE_CREATED (keeping the state machine's human-in-the-loop shape unchanged), but with
 * real data handed to them instead of needing to go find it.
 */
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
      try {
        const result = await deps.github.createBackmergePullRequest({
          owner,
          repo: repo.name,
          title: `Backmerge ${repo.releaseBranch} into ${repo.sourceBranch} (release ${release.version})`,
          head: repo.releaseBranch,
          base: repo.sourceBranch,
          body: `Automated backmerge for release ${release.version}.`,
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

async function notifyBackmergeFailed(release: Release): Promise<void> {
  log("slack.notifyBackmergeFailed", release);
}

/** Still a stub: fires on entering TAGGING_PENDING, before the operator has reported tag names. */
async function tagRepositories(release: Release): Promise<void> {
  log("github.tagRepositories (waiting on REPOS_TAGGED to report tag names)", release, {
    repos: release.repos.map((r) => r.name),
  });
}

async function notifyTaggingFailed(release: Release): Promise<void> {
  log("slack.notifyTaggingFailed", release);
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

async function notifyComplete(release: Release): Promise<void> {
  log("slack.notifyComplete", release);
}

async function notifyBlocked(release: Release): Promise<void> {
  log("slack.notifyBlocked", release);
}

async function notifyFailed(release: Release): Promise<void> {
  log("slack.notifyFailed", release);
}

async function notifyRolledBack(release: Release): Promise<void> {
  log("slack.notifyRolledBack", release);
}

async function notifyCancelled(release: Release): Promise<void> {
  log("slack.notifyCancelled", release);
}

/** Actions run on ENTERING a state (after the transition + guards have succeeded and been persisted). */
export function buildOnEnterRegistry(deps: ActionDeps = {}): Partial<Record<ReleaseState, Action[]>> {
  return {
    BRANCH_CREATED: [createReleaseBranchesAction(deps)],
    CHANGE_TICKET_CREATED: [createChangeTicket],
    QA_APPROVAL_PENDING: [sendQaApprovalMessage],
    CAB_APPROVAL_PENDING: [sendCabApprovalMessage],
    READY_TO_DEPLOY: [notifyReadyToDeploy],
    DEPLOYING: [triggerDeployment],
    SANITY_CHECKING: [runSanityChecks],
    FINALIZING: [updateTicketOnFinalize],
    TICKET_UPDATE_FAILED: [notifyTicketUpdateFailed],
    BACKMERGE_PENDING: [createBackmergePrAction(deps)],
    BACKMERGE_FAILED: [notifyBackmergeFailed],
    TAGGING_PENDING: [tagRepositories],
    TAGGING_FAILED: [notifyTaggingFailed],
    TAGGED: [tagRepositoriesOnGithubAction(deps)],
    COMPLETE: [notifyComplete],
    BLOCKED: [notifyBlocked],
    FAILED: [notifyFailed],
    ROLLED_BACK: [notifyRolledBack],
    CANCELLED: [notifyCancelled],
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
