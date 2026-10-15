#!/usr/bin/env node
import { Command } from "commander";
import { userInfo } from "node:os";
import { readFileSync } from "node:fs";
import { loadDotEnv } from "./env.js";
import { openDb } from "./db.js";
import { ReleaseStore } from "./store.js";
import { ReleaseEngine } from "./engine.js";
import { loadWorkflowConfig } from "./workflow/loader.js";
import { WorkflowExecutor } from "./workflow/executor.js";
import { LocalQwenProvider } from "./intelligence/localQwenProvider.js";
import { parseReposSpec, loadRequiredCatalog, resolveReposAgainstCatalog, catalogSummary } from "./github/resolveRepos.js";
import { readRepoPackageJsonVersion } from "./github/readPackageJson.js";
import { catalogRepoFromUrl, catalogRepoFromWorkspaceDir, parseGithubBlobPackageJsonUrl } from "./github/catalogFromDir.js";
import { catalogGithubRepo, lookupCatalogRepo, readRepoCatalog, removeCatalogRepo, upsertManualCatalogRepo, type CatalogRepo } from "./github/repoCatalog.js";
import { resolveCreatePrompts } from "./cli/promptCreate.js";
import {
  parseStatusFilter,
  resolveEventCommandArgs,
  resolveReleaseIdForEvent,
  PREPROD_EVENT_ALIASES,
} from "./cli/releaseSelect.js";
import { nextVersionFromPackage } from "./versioning.js";
import { syncOrgRepoCatalog } from "./github/syncRepos.js";
import { connectGithubMcp } from "./github/mcpClient.js";
import { GithubMcpProvider } from "./github/githubMcpProvider.js";
import { SlackRestProvider } from "./slack/slackRestProvider.js";
import { NetlifyRestProvider } from "./netlify/netlifyRestProvider.js";
import { lookupNetlifyDeploysForRepo } from "./netlify/rollbackPlan.js";
import { PREPROD_SOURCE_BRANCH, PREPROD_TARGET_BRANCH, DEFAULT_PREPROD_WORKFLOW_PATH } from "./preprod/constants.js";
import { resolveSlackApprovalEvent } from "./slack/ingestApprovals.js";
import {
  DEFAULT_GITHUB_WATCH_INTERVAL_MS,
  runGithubPrApprovalWatch,
} from "./github/watchPrApprovals.js";
import {
  acquireGithubWatchLock,
  readGithubWatchLockStatus,
  releaseGithubWatchLock,
} from "./github/watchLock.js";
import { jiraIssueCreateConfigFromEnv } from "./jira/issueConfig.js";
import { toJiraDateTime } from "./jira/plannedWindow.js";
import { connectConfiguredJira } from "./jira/connect.js";
import { runJiraLogin, runJiraLogout } from "./jira/login.js";
import { isPcmChangeApplied } from "./jira/pcmChangeFields.js";
import type { CommitInfo, FailureKind, PullRequestInfo } from "./intelligence/types.js";

loadDotEnv();

const DB_PATH = process.env.RELEASE_OPERATOR_DB ?? "./release-operator.db";
const WORKFLOW_PATH = process.env.RELEASE_OPERATOR_WORKFLOW ?? "./config/pipeline.yaml";
const PREPROD_WORKFLOW_PATH = process.env.RELEASE_OPERATOR_PREPROD_WORKFLOW ?? DEFAULT_PREPROD_WORKFLOW_PATH;

function buildEngine(): ReleaseEngine {
  const db = openDb(DB_PATH);
  return new ReleaseEngine(new ReleaseStore(db));
}

/**
 * Only used by the `event` command, since that's the only command that fires actions.
 * Intelligence is always wired in (LocalQwenProvider is cheap to construct and only ever
 * fails, loudly and non-blockingly, at the point of an actual generation call if the MLX-LM
 * server isn't running). GitHub, Jira, Slack, and Netlify are each wired only if their respective
 * credentials are configured — without them, the corresponding actions log a
 * "skipped: not configured" message and no-op.
 */
async function buildEngineForEvents(): Promise<{
  engine: ReleaseEngine;
  close: () => Promise<void>;
  github?: GithubMcpProvider;
  netlify?: NetlifyRestProvider;
}> {
  const db = openDb(DB_PATH);
  const store = new ReleaseStore(db);
  const intelligence = buildIntelligence();
  const closers: (() => Promise<void>)[] = [];

  const githubToken = process.env.RELEASE_OPERATOR_GITHUB_TOKEN;
  let github: GithubMcpProvider | undefined;
  if (githubToken) {
    const connection = await connectGithubMcp({ token: githubToken, url: process.env.RELEASE_OPERATOR_GITHUB_MCP_URL });
    github = new GithubMcpProvider({ caller: connection.caller, token: githubToken });
    closers.push(connection.close);
  }

  const jiraConnection = await connectConfiguredJira();
  if (jiraConnection) closers.push(jiraConnection.close);

  const jiraCreate = jiraIssueCreateConfigFromEnv();
  const slackToken = process.env.RELEASE_OPERATOR_SLACK_BOT_TOKEN?.trim();
  const slackChannelPrReview = process.env.RELEASE_OPERATOR_SLACK_CHANNEL_PR_REVIEW?.trim();
  const slackChannelPcmApproval = process.env.RELEASE_OPERATOR_SLACK_CHANNEL_PCM_APPROVAL?.trim();
  const slack = slackToken ? new SlackRestProvider({ token: slackToken }) : undefined;
  const netlifyToken = process.env.NETLIFY_AUTH_TOKEN?.trim();
  const netlify = netlifyToken ? new NetlifyRestProvider({ token: netlifyToken }) : undefined;
  const engine = new ReleaseEngine(store, {
    github,
    jira: jiraConnection?.provider,
    intelligence,
    slack,
    slackChannelPrReview,
    slackChannelPcmApproval,
    netlify,
    defaultGithubOrg: process.env.RELEASE_OPERATOR_GITHUB_ORG,
    jiraProjectKey: process.env.RELEASE_OPERATOR_JIRA_PROJECT_KEY,
    jiraIssueType: process.env.RELEASE_OPERATOR_JIRA_ISSUE_TYPE,
    jiraParentKey: jiraCreate.parentKey,
    jiraExtraFields: Object.keys(jiraCreate.extraFields).length > 0 ? jiraCreate.extraFields : undefined,
  });
  return { engine, github, netlify, close: async () => { for (const close of closers) await close(); } };
}

function buildWorkflow(engine: ReleaseEngine, environment: "prod" | "preprod" = "prod"): WorkflowExecutor {
  const path = environment === "preprod" ? PREPROD_WORKFLOW_PATH : WORKFLOW_PATH;
  const config = loadWorkflowConfig(path);
  return new WorkflowExecutor(engine, config);
}

function buildIntelligence(): LocalQwenProvider {
  return new LocalQwenProvider({
    baseUrl: process.env.RELEASE_OPERATOR_MLX_URL,
    model: process.env.RELEASE_OPERATOR_MLX_MODEL,
  });
}

/** Prefers a file's contents over an inline string; returns undefined if neither is given. */
function readTextOption(inline: string | undefined, filePath: string | undefined): string | undefined {
  if (filePath) return readFileSync(filePath, "utf8");
  return inline;
}

/** Accepts "name:sourceBranch", "owner/name:sourceBranch", or a github.com URL[:branch]. */
function parseRepos(spec: string): { name: string; sourceBranch: string; owner?: string }[] {
  return parseReposSpec(spec);
}

function defaultActor(): string {
  if (process.env.USER) return process.env.USER;
  if (process.env.LOGNAME) return process.env.LOGNAME;
  try {
    return userInfo().username;
  } catch {
    return "cli";
  }
}

function printRelease(release: unknown): void {
  console.log(JSON.stringify(release, null, 2));
}

const program = new Command();
program.name("release-operator").description("State-machine driven release orchestration").version("0.1.0");

program
  .command("create")
  .description("Create a draft release from bump type + repo name; version is the next semver from that repo's package.json")
  .argument("[bump]", "major, minor, or patch")
  .argument("[repo]", "catalog repo name (or owner/name)")
  .option("--env <environment>", "target environment: prod|preprod", "prod")
  .option("--by <actor>", "who is creating this release (defaults to the current user)")
  .option("--source <branch>", "branch to cut the release from (default: develop)")
  .option("--target <branch>", "branch the release PR merges into (default: main)")
  .option("--planned-start <when>", "PCM planned start, e.g. 2026-10-02 10:00")
  .option("--planned-end <when>", "PCM planned end, e.g. 2026-10-02 11:00")
  .option("--affected-services <names>", "PCM affected services, comma-separated names or ARIs")
  .option("--branch <branch>", "deprecated alias for --source")
  .action(async (
    bumpArg: string | undefined,
    repoArg: string | undefined,
    opts: {
      env: string;
      by?: string;
      source?: string;
      target?: string;
      branch?: string;
      plannedStart?: string;
      plannedEnd?: string;
      affectedServices?: string;
    }
  ) => {
    if (opts.env !== "prod" && opts.env !== "preprod") {
      console.error("--env must be 'prod' or 'preprod'");
      process.exitCode = 1;
      return;
    }
    try {
      const { bump, repo, sourceBranch, targetBranch, plannedStart, plannedEnd, affectedServices } = await resolveCreatePrompts({
        bump: bumpArg,
        repo: repoArg,
        source: opts.source ?? opts.branch,
        target: opts.target,
        plannedStart: opts.plannedStart,
        plannedEnd: opts.plannedEnd,
        affectedServices: opts.affectedServices,
      });
      const catalog = loadRequiredCatalog();
      const blob = parseGithubBlobPackageJsonUrl(repo);
      const parsed = parseRepos(repo);
      const nameHint = parsed[0];
      if (!nameHint) throw new Error("Repo name is required.");
      const catalogRow = lookupCatalogRepo(catalog, { name: nameHint.name, owner: nameHint.owner ?? blob?.owner });
      if (!catalogRow) {
        throw new Error(
          `Unknown GitHub repo "${nameHint.owner ? `${nameHint.owner}/` : ""}${nameHint.name}". Not in the local catalog.`
        );
      }
      const rowForRead = {
        ...catalogRow,
        ...(blob?.packageJsonPath ? { packageJsonPath: blob.packageJsonPath } : {}),
      };
      const pkg = await readRepoPackageJsonVersion({
        repo: rowForRead,
        branch: sourceBranch,
      });
      const version = nextVersionFromPackage(pkg.version, bump);
      const repos = resolveReposAgainstCatalog(
        [{ name: catalogRow.name, owner: catalogRow.owner, sourceBranch }],
        catalog
      ).map((r) => ({
        ...r,
        targetBranch,
        packageJsonPath: catalogRow.packageJsonPath ?? blob?.packageJsonPath ?? pkg.path,
      }));
      console.error(
        `${bump} ${catalogRow.name}: GitHub ${pkg.ref} ${pkg.version} → ${version} (source ${sourceBranch} → target ${targetBranch})`
      );
      const engine = buildEngine();
      const release = engine.createRelease({
        version,
        repos,
        environment: opts.env,
        createdBy: opts.by ?? defaultActor(),
        bump,
        ...(plannedStart ? { plannedStart: toJiraDateTime(plannedStart) } : {}),
        ...(plannedEnd ? { plannedEnd: toJiraDateTime(plannedEnd) } : {}),
        ...(affectedServices.length > 0 ? { affectedServices } : {}),
      });
      printRelease(release);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("event")
  .description("Send an event to a release. Omit the id to use the latest non-cancelled release.")
  .argument("[releaseIdOrEvent]", "release id, or event type when targeting the latest release")
  .argument("[eventType]", "action, e.g. CREATE_BRANCH, CREATE_TICKET (canonical names still work)")
  .option("--by <actor>", "who is triggering this event (defaults to the current user)")
  .option("--payload <json>", "JSON payload for the event", "{}")
  .action(async (releaseIdOrEvent: string | undefined, eventTypeArg: string | undefined, opts: { by?: string; payload: string }) => {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(opts.payload);
    } catch {
      console.error("--payload must be valid JSON");
      process.exitCode = 1;
      return;
    }
    let close: (() => Promise<void>) | undefined;
    try {
      const parsed = resolveEventCommandArgs(releaseIdOrEvent, eventTypeArg);
      const built = await buildEngineForEvents();
      close = built.close;
      const releaseId = resolveReleaseIdForEvent(built.engine.listReleases(), parsed.releaseId);
      if (!parsed.releaseId) {
        console.error(`Using latest non-cancelled release ${releaseId}`);
      }
      const current = built.engine.getRelease(releaseId);
      const workflow = buildWorkflow(built.engine, current.environment);
      const { release, fired } = await workflow.advance(releaseId, {
        type: parsed.eventType,
        payload,
        actor: opts.by ?? defaultActor(),
      });
      for (const hop of fired) {
        console.error(`auto-advanced: ${hop.event} -> ${hop.resultState}`);
      }
      printRelease(release);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    } finally {
      if (close) await close();
    }
  });

program
  .command("show")
  .description("Show the current state of a release")
  .argument("<releaseId>", "release id")
  .action((releaseId) => {
    const engine = buildEngine();
    try {
      printRelease(engine.getRelease(releaseId));
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("status")
  .description("Show which pipeline step a release is currently on")
  .argument("<releaseId>", "release id")
  .action((releaseId) => {
    const engine = buildEngine();
    try {
      const release = engine.getRelease(releaseId);
      const workflow = buildWorkflow(engine, release.environment);
      printRelease(workflow.describeStatus(release));
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("history")
  .description("Show the full event log for a release")
  .argument("<releaseId>", "release id")
  .action((releaseId) => {
    const engine = buildEngine();
    printRelease(engine.getHistory(releaseId));
  });

program
  .command("list")
  .description("List releases, optionally filtered by state")
  .option("--status <states>", "comma-separated states, e.g. DRAFT,CANCELLED")
  .option("--env <environment>", "prod or preprod")
  .action((opts: { status?: string; env?: string }) => {
    const engine = buildEngine();
    try {
      let releases = engine.listReleases();
      if (opts.env === "prod" || opts.env === "preprod") {
        releases = releases.filter((r) => r.environment === opts.env);
      }
      if (opts.status) {
        const allowed = new Set(parseStatusFilter(opts.status));
        releases = releases.filter((r) => allowed.has(r.state));
      }
      printRelease(releases);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("cleanup")
  .description("Delete local releases in the given states (and their event logs)")
  .requiredOption("--status <states>", "comma-separated states to delete, e.g. CANCELLED")
  .action((opts: { status: string }) => {
    try {
      const states = parseStatusFilter(opts.status);
      const engine = buildEngine();
      const deleted = engine.deleteReleasesInStates(states);
      printRelease({ deleted: deleted.length, ids: deleted.map((r) => r.id), states });
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

const preprod = program
  .command("preprod")
  .description("Sync develop → pre-prod-1: PR, Slack approval, merge, watch Netlify");

preprod
  .command("create")
  .description("Create a pre-prod sync for a catalog repo and open the develop → pre-prod-1 PR")
  .argument("[repo]", "catalog repo name (landings, quiz, blog, experiences)")
  .option("--by <actor>", "who is creating this sync (defaults to the current user)")
  .option("--source <branch>", `source branch (default: ${PREPROD_SOURCE_BRANCH})`)
  .option("--target <branch>", `target branch (default: ${PREPROD_TARGET_BRANCH})`)
  .action(async (repoArg: string | undefined, opts: { by?: string; source?: string; target?: string }) => {
    let close: (() => Promise<void>) | undefined;
    try {
      const repoName = repoArg?.trim();
      if (!repoName) {
        throw new Error("Usage: preprod create <repo>  e.g. preprod create landings");
      }
      const catalog = loadRequiredCatalog();
      const parsed = parseRepos(repoName);
      const nameHint = parsed[0];
      if (!nameHint) throw new Error("Repo name is required.");
      const catalogRow = lookupCatalogRepo(catalog, { name: nameHint.name, owner: nameHint.owner });
      if (!catalogRow) {
        throw new Error(
          `Unknown GitHub repo "${nameHint.owner ? `${nameHint.owner}/` : ""}${nameHint.name}". Not in the local catalog.`
        );
      }
      const sourceBranch = opts.source?.trim() || PREPROD_SOURCE_BRANCH;
      const targetBranch = opts.target?.trim() || PREPROD_TARGET_BRANCH;
      const repos = resolveReposAgainstCatalog(
        [{ name: catalogRow.name, owner: catalogRow.owner, sourceBranch }],
        catalog
      ).map((r) => ({
        ...r,
        name: catalogRow.name,
        targetBranch,
        url: catalogRow.url,
      }));
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const built = await buildEngineForEvents();
      close = built.close;
      const release = built.engine.createRelease({
        version: `preprod-${stamp}`,
        repos,
        environment: "preprod",
        createdBy: opts.by ?? defaultActor(),
      });
      console.error(
        `preprod ${catalogRow.name} (${catalogGithubRepo(catalogRow)}): ${sourceBranch} → ${targetBranch}`
      );
      const workflow = buildWorkflow(built.engine, "preprod");
      const { release: after, fired } = await workflow.advance(release.id, {
        type: "PREPROD_PR_REQUESTED",
        actor: opts.by ?? defaultActor(),
      });
      for (const hop of fired) {
        console.error(`auto-advanced: ${hop.event} -> ${hop.resultState}`);
      }
      printRelease(after);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    } finally {
      if (close) await close();
    }
  });

preprod
  .command("event")
  .description("Send an event to the latest preprod-sync (or a given id)")
  .argument("[releaseIdOrEvent]", "release id, or event type when targeting the latest preprod sync")
  .argument("[eventType]", "e.g. APPROVE, START, PREPROD_APPROVED")
  .option("--by <actor>", "who is triggering this event (defaults to the current user)")
  .option("--payload <json>", "JSON payload for the event", "{}")
  .action(async (releaseIdOrEvent: string | undefined, eventTypeArg: string | undefined, opts: { by?: string; payload: string }) => {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(opts.payload);
    } catch {
      console.error("--payload must be valid JSON");
      process.exitCode = 1;
      return;
    }
    let close: (() => Promise<void>) | undefined;
    try {
      const parsed = resolveEventCommandArgs(releaseIdOrEvent, eventTypeArg, PREPROD_EVENT_ALIASES);
      const built = await buildEngineForEvents();
      close = built.close;
      const releaseId = resolveReleaseIdForEvent(
        built.engine.listReleases(),
        parsed.releaseId,
        (r) => r.environment === "preprod"
      );
      if (!parsed.releaseId) {
        console.error(`Using latest preprod-sync ${releaseId}`);
      }
      const workflow = buildWorkflow(built.engine, "preprod");
      const { release, fired } = await workflow.advance(releaseId, {
        type: parsed.eventType,
        payload,
        actor: opts.by ?? defaultActor(),
      });
      for (const hop of fired) {
        console.error(`auto-advanced: ${hop.event} -> ${hop.resultState}`);
      }
      printRelease(release);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    } finally {
      if (close) await close();
    }
  });

const github = program
  .command("github")
  .description("Real GitHub integration status (branches/PRs via MCP, tags via direct REST fallback)");

function printGithubWatchStatus(): void {
  const status = readGithubWatchLockStatus();
  if (!status.running) {
    printRelease({
      running: false,
      lockPath: status.path,
      ...(status.stale ? { stalePid: status.stale.pid } : {}),
    });
    return;
  }
  printRelease({
    running: true,
    pid: status.lock.pid,
    startedAt: status.lock.startedAt,
    intervalSeconds: status.lock.intervalMs / 1000,
    ...(status.lock.releaseId ? { releaseId: status.lock.releaseId } : {}),
    lockPath: status.path,
  });
}

github
  .command("watch")
  .description("Poll GitHub PR reviews + Netlify pre-prod deploys; merge when approved")
  .argument("[releaseId]", "optional: only this release; otherwise every pending pre-prod release")
  .option("--interval <seconds>", "seconds between polls", "60")
  .option("--status", "print whether a watcher is already running, then exit")
  .option("--by <actor>", "who is ingesting the GitHub review")
  .action(async (releaseId: string | undefined, opts: { interval: string; status?: boolean; by?: string }) => {
    if (opts.status) {
      printGithubWatchStatus();
      return;
    }
    const githubToken = process.env.RELEASE_OPERATOR_GITHUB_TOKEN?.trim();
    if (!githubToken) {
      console.error("RELEASE_OPERATOR_GITHUB_TOKEN is not set.");
      process.exitCode = 1;
      return;
    }
    const intervalSec = Number(opts.interval);
    if (!Number.isFinite(intervalSec) || intervalSec < 1) {
      console.error("--interval must be a number of seconds >= 1.");
      process.exitCode = 1;
      return;
    }
    const intervalMs = Math.round(intervalSec * 1000) || DEFAULT_GITHUB_WATCH_INTERVAL_MS;
    const acquired = acquireGithubWatchLock({
      pid: process.pid,
      intervalMs,
      releaseId,
    });
    if (!acquired.ok) {
      console.error(
        `GitHub watcher already running (pid ${acquired.lock.pid}, started ${acquired.lock.startedAt}). ` +
          `Check with: npm run cli -- github watch --status`
      );
      process.exitCode = 1;
      return;
    }
    const ac = new AbortController();
    const stop = (): void => ac.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    let close: (() => Promise<void>) | undefined;
    try {
      const built = await buildEngineForEvents();
      close = built.close;
      if (!built.github) {
        console.error("GitHub provider failed to initialize.");
        process.exitCode = 1;
        return;
      }
      if (!built.netlify) {
        console.error("Warning: NETLIFY_AUTH_TOKEN unset — PR approve/merge will work, but Netlify deploy watch will idle.");
      }
      const actor = opts.by ?? defaultActor();
      console.error(
        `Watching pre-prod (GitHub reviews + Netlify deploys) every ${intervalSec}s` +
          (releaseId ? ` for ${releaseId}` : "") +
          ` (pid ${process.pid}). Ctrl-C to stop.`
      );
      await runGithubPrApprovalWatch({
        listReleases: () => built.engine.listReleases(),
        github: built.github,
        netlify: built.netlify,
        actor,
        intervalMs,
        signal: ac.signal,
        releaseId,
        advance: async (id, event) => {
          const current = built.engine.getRelease(id);
          return buildWorkflow(built.engine, current.environment).advance(id, event);
        },
        onTick: (tick) => {
          for (const err of tick.errors) {
            console.error(`${err.releaseId}: ${err.message}`);
          }
          for (const applied of tick.applied) {
            console.error(`${applied.releaseId}: ${applied.eventType} -> ${applied.state}`);
            for (const hop of applied.fired) {
              console.error(`  auto-advanced: ${hop.event} -> ${hop.resultState}`);
            }
            if (applied.deployLines) {
              for (const line of applied.deployLines) console.error(`  ${line}`);
            }
            printRelease(built.engine.getRelease(applied.releaseId));
          }
          if (tick.applied.length === 0 && tick.errors.length === 0) {
            if (tick.checked === 0) {
              console.error("No pre-prod releases waiting on GitHub approval or Netlify deploys.");
            } else {
              console.error(`Waiting on ${tick.checked} pre-prod release(s):`);
              for (const idle of tick.idle) {
                console.error(`  ${idle.releaseId}: ${idle.reason}`);
              }
            }
          }
        },
      });
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      releaseGithubWatchLock({ pid: process.pid });
      if (close) await close();
    }
  });

github
  .command("status")
  .description("Check whether GitHub's remote MCP server is reachable")
  .action(async () => {
    const token = process.env.RELEASE_OPERATOR_GITHUB_TOKEN;
    if (!token) {
      console.error("RELEASE_OPERATOR_GITHUB_TOKEN is not set — GitHub actions will no-op.");
      process.exitCode = 1;
      return;
    }
    try {
      const connection = await connectGithubMcp({ token, url: process.env.RELEASE_OPERATOR_GITHUB_MCP_URL });
      const caller = connection.caller as { listTools?: () => Promise<{ tools: { name: string }[] }> };
      const tools = (await caller.listTools?.())?.tools ?? [];
      console.log(`Reachable. ${tools.length} tool(s) available (e.g. ${tools.slice(0, 5).map((t) => t.name).join(", ")}).`);
      await connection.close();
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

github
  .command("sync-repos")
  .description("Fetch all repositories in RELEASE_OPERATOR_GITHUB_ORG via MCP and save a local name→URL catalog")
  .action(async () => {
    try {
      const catalog = await syncOrgRepoCatalog();
      const summary = catalogSummary(catalog);
      const manuals = catalog.repos.filter((r) => r.source === "manual").length;
      console.log(
        `Synced ${summary.count} repo(s) for org ${summary.org} at ${summary.syncedAt}` +
          `${manuals > 0 ? ` (kept ${manuals} manual test override(s))` : ""}. Catalog: .github-repos.json`
      );
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

const githubRepos = github
  .command("repos")
  .description("Local GitHub name→URL catalog used to validate --repos (sync + manual test entries)");

function printGithubCatalog(): void {
  const catalog = readRepoCatalog();
  if (!catalog) {
    console.error("No catalog yet. Run `github sync-repos` or `github repos add --from-dir <clone>`.");
    process.exitCode = 1;
    return;
  }
  printRelease({
    org: catalog.org,
    syncedAt: catalog.syncedAt,
    repos: catalog.repos.map((r) => ({
      name: r.name,
      owner: r.owner,
      url: r.url,
      source: r.source ?? "sync",
      ...(r.localPath ? { localPath: r.localPath } : {}),
      ...(r.defaultBranch ? { defaultBranch: r.defaultBranch } : {}),
      ...(r.packageJsonPath ? { packageJsonPath: r.packageJsonPath } : {}),
      ...(r.githubRepo ? { githubRepo: r.githubRepo } : {}),
    })),
  });
}

githubRepos
  .command("list", { isDefault: true })
  .description("Show the local name→URL catalog")
  .action(() => {
    try {
      printGithubCatalog();
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

githubRepos
  .command("add")
  .description("Register a test/local clone or override URL; survives `github sync-repos`")
  .option("--from-dir <path>", "local clone directory (reads git remote origin when present)")
  .option("--name <name>", "unique catalog alias (does not overwrite an existing row with the GitHub repo name)")
  .option("--url <url>", "github.com URL, blob URL (e.g. .../blob/main/app/package.json), or filesystem path")
  .option("--owner <owner>", "owner/org (default: origin owner, RELEASE_OPERATOR_GITHUB_ORG, or local)")
  .option("--package-json <path>", "path to package.json in the repo (e.g. app/package.json)")
  .option("--default-branch <branch>", "default source branch (e.g. main)")
  .option("--replace", "overwrite an existing catalog row with the same --name")
  .action((opts: {
    fromDir?: string;
    name?: string;
    url?: string;
    owner?: string;
    packageJson?: string;
    defaultBranch?: string;
    replace?: boolean;
  }) => {
    try {
      let repo: CatalogRepo;
      if (opts.fromDir) {
        repo = catalogRepoFromWorkspaceDir(opts.fromDir, {
          name: opts.name,
          owner: opts.owner,
          url: opts.url,
          defaultBranch: opts.defaultBranch,
          packageJsonPath: opts.packageJson,
        });
      } else if (opts.url) {
        repo = catalogRepoFromUrl({
          url: opts.url,
          name: opts.name,
          owner: opts.owner,
          defaultBranch: opts.defaultBranch,
          packageJsonPath: opts.packageJson,
        });
      } else {
        console.error("Pass --from-dir <clone> or --url <github-or-blob-url>.");
        process.exitCode = 1;
        return;
      }
      upsertManualCatalogRepo(repo, undefined, { replace: opts.replace });
      console.log(
        `Added manual catalog entry ${repo.name}` +
          `${repo.githubRepo ? ` (GitHub ${repo.fullName})` : ""} → ${repo.url}`
      );
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

githubRepos
  .command("remove")
  .description("Remove a catalog row by name (manual test entries, or a synced name until the next sync)")
  .argument("<name>", "repo name or owner/name")
  .action((name: string) => {
    try {
      removeCatalogRepo(name);
      console.log(`Removed catalog entry ${name}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

const jira = program
  .command("jira")
  .description("Jira integration: Atlassian 3LO (`jira login`) or API-token MCP fallback");

jira
  .command("login")
  .description("Authorize this CLI with Atlassian 3LO and store tokens in .jira-oauth.json (gitignored)")
  .option("--import-env", "import RELEASE_OPERATOR_JIRA_OAUTH_ACCESS_TOKEN instead of running the browser flow")
  .option("--no-browser", "print the authorize URL without opening a browser")
  .action(async (opts: { importEnv?: boolean; browser?: boolean }) => {
    try {
      if (opts.importEnv && !process.env.RELEASE_OPERATOR_JIRA_OAUTH_ACCESS_TOKEN) {
        console.error("RELEASE_OPERATOR_JIRA_OAUTH_ACCESS_TOKEN is unset; cannot --import-env.");
        process.exitCode = 1;
        return;
      }
      const result = await runJiraLogin({
        importAccessToken: opts.importEnv ? process.env.RELEASE_OPERATOR_JIRA_OAUTH_ACCESS_TOKEN : undefined,
        openBrowser: opts.browser !== false,
      });
      console.log(
        `Saved Jira OAuth tokens to ${result.storePath} (gitignored). site=${result.siteUrl} cloudId=${result.cloudId}`
      );
      if (!result.hasRefreshToken) {
        console.error(
          "No refresh_token was issued. Re-run `jira login` after confirming the Atlassian app " +
            "requests the offline_access scope (this CLI already includes it in the authorize URL)."
        );
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

jira
  .command("logout")
  .description("Delete the local Jira OAuth token store")
  .action(() => {
    const path = runJiraLogout();
    console.log(`Removed ${path} (if it existed).`);
  });

jira
  .command("status")
  .description("Check whether Jira is reachable (3LO REST or API-token MCP)")
  .action(async () => {
    try {
      const connection = await connectConfiguredJira();
      if (!connection) {
        console.error(
          "Jira is not configured. Run `jira login` (3LO) or set RELEASE_OPERATOR_JIRA_EMAIL, " +
            "RELEASE_OPERATOR_JIRA_TOKEN, and RELEASE_OPERATOR_JIRA_SITE (API token MCP fallback)."
        );
        process.exitCode = 1;
        return;
      }
      if (connection.mode === "oauth" && connection.rest) {
        const me = await connection.rest.myself();
        const parsed = JSON.parse(me) as Record<string, unknown>;
        const account = typeof parsed.displayName === "string" ? parsed.displayName : "(unknown)";
        console.log(`Reachable via Atlassian 3LO REST. Authenticated as ${account}.`);
      } else {
        console.log("Reachable via Atlassian MCP (API token).");
      }
      await connection.close();
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

jira
  .command("change-applied")
  .description("If the PCM ticket is in Change Applied, advance the release to open the backmerge PR")
  .argument("<releaseId>", "release id")
  .option("--by <actor>", "who is confirming Change Applied")
  .action(async (releaseId: string, opts: { by?: string }) => {
    let close: (() => Promise<void>) | undefined;
    try {
      const built = await buildEngineForEvents();
      close = built.close;
      const release = built.engine.getRelease(releaseId);
      const ticketId = release.ticket?.id?.trim();
      if (!ticketId) {
        console.error("No PCM ticket is recorded on this release.");
        process.exitCode = 1;
        return;
      }
      const connection = await connectConfiguredJira();
      if (!connection) {
        console.error("Jira is not configured. Run `jira login` first.");
        process.exitCode = 1;
        return;
      }
      try {
        const issue = await connection.provider.getIssue(ticketId);
        if (!isPcmChangeApplied(issue.status)) {
          console.error(
            `PCM ${ticketId} is "${issue.status ?? "(unknown status)"}", not "Change Applied".`
          );
          process.exitCode = 1;
          return;
        }
      } finally {
        await connection.close();
      }
      const workflow = buildWorkflow(built.engine, release.environment);
      const { release: after, fired } = await workflow.advance(releaseId, {
        type: "CHANGE_APPLIED",
        actor: opts.by ?? defaultActor(),
      });
      for (const hop of fired) {
        console.error(`auto-advanced: ${hop.event} -> ${hop.resultState}`);
      }
      printRelease(after);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    } finally {
      if (close) await close();
    }
  });

const slack = program
  .command("slack")
  .description("Slack Web API: post pipeline notices and ingest QA/CAB replies from a thread");

slack
  .command("ping")
  .description("Check whether the Slack bot token can call auth.test")
  .action(async () => {
    const token = process.env.RELEASE_OPERATOR_SLACK_BOT_TOKEN?.trim();
    if (!token) {
      console.error("RELEASE_OPERATOR_SLACK_BOT_TOKEN is not set — Slack actions will no-op.");
      process.exitCode = 1;
      return;
    }
    try {
      const result = await new SlackRestProvider({ token }).authTest();
      const who = result.user ?? result.userId ?? "(unknown user)";
      const team = result.team ?? "(unknown team)";
      const prReview = process.env.RELEASE_OPERATOR_SLACK_CHANNEL_PR_REVIEW?.trim();
      const pcmApproval = process.env.RELEASE_OPERATOR_SLACK_CHANNEL_PCM_APPROVAL?.trim();
      const channels = [
        prReview ? `PR review ${prReview}` : "PR review channel unset",
        pcmApproval ? `PCM approval ${pcmApproval}` : "PCM approval channel unset",
      ].join("; ");
      console.log(`Reachable. Authenticated as ${who} on ${team}. ${channels}.`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

slack
  .command("ingest-approvals")
  .description("Read the QA or CAB Slack thread and apply approve/reject if a human replied")
  .argument("<releaseId>", "release id")
  .option("--by <actor>", "who is ingesting this reply")
  .action(async (releaseId: string, opts: { by?: string }) => {
    const token = process.env.RELEASE_OPERATOR_SLACK_BOT_TOKEN?.trim();
    if (!token) {
      console.error("RELEASE_OPERATOR_SLACK_BOT_TOKEN is not set.");
      process.exitCode = 1;
      return;
    }
    let close: (() => Promise<void>) | undefined;
    try {
      const built = await buildEngineForEvents();
      close = built.close;
      const release = built.engine.getRelease(releaseId);
      const slackClient = new SlackRestProvider({ token });
      const result = await resolveSlackApprovalEvent({
        release,
        slack: slackClient,
        actor: opts.by ?? defaultActor(),
      });
      if (result.status === "noop") {
        console.error(result.reason);
        if (result.replies.length > 0) {
          printRelease(result.replies.map((m) => ({ ts: m.ts, user: m.user, text: m.text })));
        }
        return;
      }
      const workflow = buildWorkflow(built.engine, release.environment);
      const { release: after, fired } = await workflow.advance(releaseId, result.event);
      for (const hop of fired) {
        console.error(`auto-advanced: ${hop.event} -> ${hop.resultState}`);
      }
      printRelease(after);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    } finally {
      if (close) await close();
    }
  });

const netlifyCmd = program
  .command("netlify")
  .description("Look up live Netlify production deploys (same call PCM rollback uses)");

netlifyCmd
  .command("deploys")
  .description("Print the latest main-branch production deploy for a repo's US and MX sites")
  .argument("[repo]", "GitHub repo name, e.g. landings", "landings")
  .action(async (repo: string) => {
    const token = process.env.NETLIFY_AUTH_TOKEN?.trim();
    if (!token) {
      console.error("NETLIFY_AUTH_TOKEN is not set.");
      process.exitCode = 1;
      return;
    }
    try {
      const result = await lookupNetlifyDeploysForRepo(repo, new NetlifyRestProvider({ token }));
      printRelease(result);
      if (result.sites.some((site) => !site.ok)) process.exitCode = 1;
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

const intelligence = program
  .command("intelligence")
  .description(
    "Advisory-only text generation via a local SLM (MLX-LM). Never reads or changes release " +
      "state — output is printed for a human to review and use manually."
  );

intelligence
  .command("status")
  .description("Check whether the local MLX-LM server is reachable")
  .action(async () => {
    const result = await buildIntelligence().status();
    if (result.reachable) {
      console.log(`Reachable. Models loaded: ${result.models.join(", ") || "(none reported)"}`);
    } else {
      console.error(`Not reachable: ${result.reason}`);
      process.exitCode = 1;
    }
  });

intelligence
  .command("ticket-description")
  .description("Draft a change-management ticket description for a release")
  .argument("<releaseId>", "release id")
  .option("--context <text>", "additional free-form context")
  .option("--context-file <path>", "read additional context from a file")
  .action(async (releaseId, opts) => {
    const engine = buildEngine();
    try {
      const release = engine.getRelease(releaseId);
      const text = await buildIntelligence().generateTicketDescription({
        release,
        context: readTextOption(opts.context, opts.contextFile),
      });
      console.log(text);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

intelligence
  .command("release-notes")
  .description("Generate release notes for a release")
  .argument("<releaseId>", "release id")
  .option("--changes-summary <text>", "a change summary to draw from")
  .option("--changes-file <path>", "read the change summary from a file")
  .action(async (releaseId, opts) => {
    const engine = buildEngine();
    try {
      const release = engine.getRelease(releaseId);
      const text = await buildIntelligence().generateReleaseNotes({
        release,
        changesSummary: readTextOption(opts.changesSummary, opts.changesFile),
      });
      console.log(text);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

intelligence
  .command("summarize-changes")
  .description("Summarize a set of commits and pull requests")
  .requiredOption("--commits-file <path>", 'JSON file: { "commits": [...], "pullRequests": [...] }')
  .option("--release <releaseId>", "optional release id for context")
  .action(async (opts) => {
    try {
      const parsed = JSON.parse(readFileSync(opts.commitsFile, "utf8")) as {
        commits: CommitInfo[];
        pullRequests?: PullRequestInfo[];
      };
      const release = opts.release ? buildEngine().getRelease(opts.release) : undefined;
      const text = await buildIntelligence().summarizeChanges({
        release,
        commits: parsed.commits,
        pullRequests: parsed.pullRequests,
      });
      console.log(text);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

intelligence
  .command("affected-components")
  .description("Identify components/services likely affected by a release")
  .argument("<releaseId>", "release id")
  .option("--changed-files <list>", "comma-separated list of changed file paths")
  .option("--context <text>", "additional free-form context")
  .option("--context-file <path>", "read additional context from a file")
  .action(async (releaseId, opts) => {
    const engine = buildEngine();
    try {
      const release = engine.getRelease(releaseId);
      const components = await buildIntelligence().identifyAffectedComponents({
        release,
        changedFiles: opts.changedFiles ? opts.changedFiles.split(",").map((s: string) => s.trim()) : undefined,
        context: readTextOption(opts.context, opts.contextFile),
      });
      console.log(JSON.stringify(components, null, 2));
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

intelligence
  .command("suggest-tests")
  .description("Suggest sanity/regression tests based on a release's changes")
  .argument("<releaseId>", "release id")
  .option("--changed-files <list>", "comma-separated list of changed file paths")
  .option("--context <text>", "additional free-form context")
  .option("--context-file <path>", "read additional context from a file")
  .action(async (releaseId, opts) => {
    const engine = buildEngine();
    try {
      const release = engine.getRelease(releaseId);
      const tests = await buildIntelligence().suggestSanityTests({
        release,
        changedFiles: opts.changedFiles ? opts.changedFiles.split(",").map((s: string) => s.trim()) : undefined,
        context: readTextOption(opts.context, opts.contextFile),
      });
      console.log(JSON.stringify(tests, null, 2));
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

intelligence
  .command("summarize-failure")
  .description("Summarize CI/deployment/test failure logs")
  .requiredOption("--logs-file <path>", "path to the failure log text")
  .option("--kind <kind>", "ci|deployment|test|sanity", "ci")
  .option("--release <releaseId>", "optional release id for context")
  .action(async (opts) => {
    try {
      const release = opts.release ? buildEngine().getRelease(opts.release) : undefined;
      const text = await buildIntelligence().summarizeFailure({
        release,
        kind: opts.kind as FailureKind,
        logs: readFileSync(opts.logsFile, "utf8"),
      });
      console.log(text);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);
