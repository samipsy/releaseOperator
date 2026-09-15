#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { openDb } from "./db.js";
import { ReleaseStore } from "./store.js";
import { ReleaseEngine } from "./engine.js";
import { loadWorkflowConfig } from "./workflow/loader.js";
import { WorkflowExecutor } from "./workflow/executor.js";
import { LocalQwenProvider } from "./intelligence/localQwenProvider.js";
import { connectGithubMcp } from "./github/mcpClient.js";
import { GithubMcpProvider } from "./github/githubMcpProvider.js";
import type { ReleaseEventType } from "./types.js";
import type { CommitInfo, FailureKind, PullRequestInfo } from "./intelligence/types.js";

const DB_PATH = process.env.RELEASE_OPERATOR_DB ?? "./release-operator.db";
const WORKFLOW_PATH = process.env.RELEASE_OPERATOR_WORKFLOW ?? "./config/pipeline.yaml";

function buildEngine(): ReleaseEngine {
  const db = openDb(DB_PATH);
  return new ReleaseEngine(new ReleaseStore(db));
}

/**
 * Only used by the `event` command, since that's the only command that fires actions.
 * If RELEASE_OPERATOR_GITHUB_TOKEN isn't set, GitHub integration is simply absent —
 * the branch/PR/tag actions log a "skipped: not configured" message and no-op.
 */
async function buildEngineWithGithub(): Promise<{ engine: ReleaseEngine; closeGithub?: () => Promise<void> }> {
  const db = openDb(DB_PATH);
  const store = new ReleaseStore(db);
  const token = process.env.RELEASE_OPERATOR_GITHUB_TOKEN;
  if (!token) {
    return { engine: new ReleaseEngine(store) };
  }
  const connection = await connectGithubMcp({ token, url: process.env.RELEASE_OPERATOR_GITHUB_MCP_URL });
  const github = new GithubMcpProvider({ caller: connection.caller, token });
  const engine = new ReleaseEngine(store, { github, defaultGithubOrg: process.env.RELEASE_OPERATOR_GITHUB_ORG });
  return { engine, closeGithub: connection.close };
}

function buildWorkflow(engine: ReleaseEngine): WorkflowExecutor {
  const config = loadWorkflowConfig(WORKFLOW_PATH);
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

/** Accepts "name:sourceBranch" or "owner/name:sourceBranch"; owner falls back to RELEASE_OPERATOR_GITHUB_ORG. */
function parseRepos(spec: string): { name: string; sourceBranch: string; owner?: string }[] {
  return spec.split(",").map((entry) => {
    const [repoPart, sourceBranch = "main"] = entry.split(":").map((s) => s.trim());
    if (!repoPart) throw new Error(`invalid --repos entry: "${entry}"`);
    const slash = repoPart.lastIndexOf("/");
    if (slash === -1) return { name: repoPart, sourceBranch };
    return { owner: repoPart.slice(0, slash), name: repoPart.slice(slash + 1), sourceBranch };
  });
}

function printRelease(release: unknown): void {
  console.log(JSON.stringify(release, null, 2));
}

const program = new Command();
program.name("release-operator").description("State-machine driven release orchestration").version("0.1.0");

program
  .command("create")
  .description("Create a new release in DRAFT state")
  .argument("<version>", "release version, e.g. 2026.09.14")
  .requiredOption("--repos <spec>", "comma-separated repo:sourceBranch pairs, e.g. web:main,api:main")
  .requiredOption("--env <environment>", "target environment: prod|preprod")
  .requiredOption("--by <actor>", "who is creating this release")
  .action((version, opts) => {
    const engine = buildEngine();
    if (opts.env !== "prod" && opts.env !== "preprod") {
      console.error("--env must be 'prod' or 'preprod'");
      process.exitCode = 1;
      return;
    }
    const release = engine.createRelease({
      version,
      repos: parseRepos(opts.repos),
      environment: opts.env,
      createdBy: opts.by,
    });
    printRelease(release);
  });

program
  .command("event")
  .description("Send an event to a release")
  .argument("<releaseId>", "release id")
  .argument("<eventType>", "event type, e.g. BRANCHES_CREATED")
  .requiredOption("--by <actor>", "who is triggering this event")
  .option("--payload <json>", "JSON payload for the event", "{}")
  .action(async (releaseId, eventType, opts) => {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(opts.payload);
    } catch {
      console.error("--payload must be valid JSON");
      process.exitCode = 1;
      return;
    }
    let closeGithub: (() => Promise<void>) | undefined;
    try {
      const built = await buildEngineWithGithub();
      closeGithub = built.closeGithub;
      const workflow = buildWorkflow(built.engine);
      const { release, fired } = await workflow.advance(releaseId, {
        type: eventType as ReleaseEventType,
        payload,
        actor: opts.by,
      });
      for (const hop of fired) {
        console.error(`auto-advanced: ${hop.event} -> ${hop.resultState}`);
      }
      printRelease(release);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    } finally {
      if (closeGithub) await closeGithub();
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
      const workflow = buildWorkflow(engine);
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
  .description("List all releases")
  .action(() => {
    const engine = buildEngine();
    printRelease(engine.listReleases());
  });

const github = program
  .command("github")
  .description("Real GitHub integration status (branches/PRs via MCP, tags via direct REST fallback)");

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
