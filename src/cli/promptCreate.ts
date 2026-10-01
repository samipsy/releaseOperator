import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { parseReleaseBump, type ReleaseBump } from "../versioning.js";
import { DEFAULT_RELEASE_MERGE_BASE, DEFAULT_RELEASE_SOURCE_BRANCH } from "../github/releaseBranches.js";
import { parseReposSpec, repoArgHasExplicitBranch } from "../github/resolveRepos.js";
import { parseAffectedServices } from "../jira/affectedServices.js";

export interface ResolveCreatePromptsInput {
  bump?: string;
  repo?: string;
  source?: string;
  target?: string;
  plannedStart?: string;
  plannedEnd?: string;
  affectedServices?: string;
  stdinIsTty?: boolean;
  ask?: (prompt: string) => Promise<string>;
}

export interface ResolvedCreatePrompts {
  bump: ReleaseBump;
  repo: string;
  sourceBranch: string;
  targetBranch: string;
  plannedStart?: string;
  plannedEnd?: string;
  affectedServices: string[];
}

export async function resolveCreatePrompts(args: ResolveCreatePromptsInput): Promise<ResolvedCreatePrompts> {
  let bumpRaw = args.bump?.trim() ?? "";
  let repo = args.repo?.trim() ?? "";
  let source = args.source?.trim() ?? "";
  let target = args.target?.trim() ?? "";
  let plannedStart = args.plannedStart?.trim() ?? "";
  let plannedEnd = args.plannedEnd?.trim() ?? "";
  let affectedRaw = args.affectedServices?.trim() ?? "";
  const tty = args.stdinIsTty ?? Boolean(input.isTTY);

  if (repo && !source && repoArgHasExplicitBranch(repo)) {
    source = parseReposSpec(repo)[0]?.sourceBranch ?? "";
  }

  const missingBumpOrRepo = !bumpRaw || !repo;
  const missingBranches = !source || !target;
  const missingWindow = !plannedStart || !plannedEnd;
  const needsAsk = missingBumpOrRepo || missingBranches || missingWindow;

  if (needsAsk && !tty && missingBumpOrRepo) {
    throw new Error(
      "Usage: create <major|minor|patch> <repo> [--source <branch>] [--target <branch>] [--planned-start <when>] [--planned-end <when>]"
    );
  }

  if (needsAsk && tty) {
    const prompts: string[] = [];
    if (!bumpRaw) prompts.push("What type of release is this? (major, minor, patch): ");
    if (!repo) prompts.push("Repo name: ");
    if (!source) prompts.push(`Source branch (cut from) [${DEFAULT_RELEASE_SOURCE_BRANCH}]: `);
    if (!target) prompts.push(`Target branch (PR merges into) [${DEFAULT_RELEASE_MERGE_BASE}]: `);
    if (!plannedStart) prompts.push("Planned start (e.g. 2026-10-02 20:00 Chicago): ");
    if (!plannedEnd) prompts.push("Planned end (e.g. 2026-10-02 21:00 Chicago): ");

    const answers: string[] = [];
    if (args.ask) {
      for (const prompt of prompts) {
        answers.push(await args.ask(prompt));
      }
    } else {
      const rl = createInterface({ input, output });
      try {
        for (const prompt of prompts) {
          answers.push(await rl.question(prompt));
        }
      } finally {
        rl.close();
      }
    }

    let i = 0;
    if (!bumpRaw) bumpRaw = answers[i++]?.trim() ?? "";
    if (!repo) repo = answers[i++]?.trim() ?? "";
    if (!source) source = answers[i++]?.trim() ?? "";
    if (!target) target = answers[i++]?.trim() ?? "";
    if (!plannedStart) plannedStart = answers[i++]?.trim() ?? "";
    if (!plannedEnd) plannedEnd = answers[i++]?.trim() ?? "";
  }

  if (!repo) throw new Error("Repo name is required.");

  const affectedServices = parseAffectedServices(affectedRaw);

  return {
    bump: parseReleaseBump(bumpRaw),
    repo,
    sourceBranch: source || DEFAULT_RELEASE_SOURCE_BRANCH,
    targetBranch: target || DEFAULT_RELEASE_MERGE_BASE,
    ...(plannedStart ? { plannedStart } : {}),
    ...(plannedEnd ? { plannedEnd } : {}),
    affectedServices,
  };
}
