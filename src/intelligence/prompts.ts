import type { Release } from "../types.js";
import type {
  AffectedComponentsInput,
  ChangeSummaryInput,
  FailureSummaryInput,
  ReleaseNotesInput,
  SanityTestSuggestionInput,
  TicketDescriptionInput,
} from "./types.js";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

/**
 * Shared system prompt: the model is told, explicitly, that it drafts text for human
 * review and never makes release decisions. This is a prompt-level reinforcement, not
 * a safety boundary by itself — the real boundary is that nothing in engine.ts ever
 * calls this provider or reads its output.
 */
const SYSTEM_PROMPT = [
  "You are a release engineering assistant embedded in an internal release orchestration tool.",
  "You draft text and summaries for a human to review before use.",
  "You never approve, reject, or make decisions about releases, QA/CAB sign-off, feature flags,",
  "or deployments — those are handled entirely outside of you by a separate deterministic system.",
  "Base your output only on the information given to you in the user message; do not invent",
  "ticket IDs, approver names, commit hashes, dates, or other facts not present in the input.",
  "Be direct and factual. No filler, no disclaimers, no markdown headers unless asked for.",
].join(" ");

function releaseSummaryBlock(release: Release): string {
  const repoLines = release.repos
    .map((r) => `  - ${r.name}: ${r.sourceBranch}${r.releaseBranch ? ` -> ${r.releaseBranch}` : ""}`)
    .join("\n");

  return [
    `Version: ${release.version}`,
    `Environment: ${release.environment}`,
    `Current state: ${release.state}`,
    `Repositories:\n${repoLines}`,
    release.ticket?.id ? `Change ticket: ${release.ticket.id}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function userMessage(content: string): ChatMessage {
  return { role: "user", content };
}

function withSystem(content: string): ChatMessage[] {
  return [{ role: "system", content: SYSTEM_PROMPT }, userMessage(content)];
}

export function ticketDescriptionPrompt(input: TicketDescriptionInput): ChatMessage[] {
  return withSystem(
    [
      "Draft a change-management ticket description for the following release.",
      "Write 2-4 short paragraphs or a short paragraph plus a bullet list of notable changes.",
      "Do not include a title or ticket ID field — just the description body.",
      "",
      releaseSummaryBlock(input.release),
      input.context ? `\nAdditional context:\n${input.context}` : "",
    ].join("\n")
  );
}

export function changeSummaryPrompt(input: ChangeSummaryInput): ChatMessage[] {
  const commitLines = input.commits.map((c) => `  - ${c.sha.slice(0, 8)} ${c.message}${c.author ? ` (${c.author})` : ""}`);
  const prLines = (input.pullRequests ?? []).map(
    (pr) => `  - #${pr.number} ${pr.title}${pr.body ? `: ${pr.body}` : ""}`
  );

  return withSystem(
    [
      "Summarize the following commits and pull requests into a short, readable summary of what",
      "changed, grouped by theme where it makes sense (features, fixes, chores, etc.).",
      input.release ? `\nRelease: ${input.release.version} (${input.release.environment})` : "",
      "\nCommits:",
      ...commitLines,
      prLines.length > 0 ? "\nPull requests:" : "",
      ...prLines,
    ]
      .filter((line) => line !== "")
      .join("\n")
  );
}

export function releaseNotesPrompt(input: ReleaseNotesInput): ChatMessage[] {
  return withSystem(
    [
      "Write user-facing release notes for the following release, in markdown with short bullet",
      "points grouped under headings like 'New', 'Fixed', 'Changed' as applicable. Omit any",
      "heading with nothing under it.",
      "",
      releaseSummaryBlock(input.release),
      input.changesSummary ? `\nChange summary to draw from:\n${input.changesSummary}` : "",
    ].join("\n")
  );
}

const JSON_ARRAY_INSTRUCTION =
  "Respond with ONLY a JSON array of strings, nothing else — no explanation, no markdown fences.";

export function affectedComponentsPrompt(input: AffectedComponentsInput): ChatMessage[] {
  return withSystem(
    [
      "Based on the release context below, list the components or services most likely affected",
      "by this release.",
      JSON_ARRAY_INSTRUCTION,
      "",
      releaseSummaryBlock(input.release),
      input.changedFiles && input.changedFiles.length > 0
        ? `\nChanged files:\n${input.changedFiles.map((f) => `  - ${f}`).join("\n")}`
        : "",
      input.context ? `\nAdditional context:\n${input.context}` : "",
    ].join("\n")
  );
}

export function sanityTestSuggestionPrompt(input: SanityTestSuggestionInput): ChatMessage[] {
  return withSystem(
    [
      "Based on the release context below, suggest specific sanity/regression test cases a QA",
      "engineer should run before sign-off. Each item should be one concrete, actionable check.",
      JSON_ARRAY_INSTRUCTION,
      "",
      releaseSummaryBlock(input.release),
      input.changedFiles && input.changedFiles.length > 0
        ? `\nChanged files:\n${input.changedFiles.map((f) => `  - ${f}`).join("\n")}`
        : "",
      input.context ? `\nAdditional context:\n${input.context}` : "",
    ].join("\n")
  );
}

export function failureSummaryPrompt(input: FailureSummaryInput): ChatMessage[] {
  return withSystem(
    [
      `Summarize the following ${input.kind} failure logs for a release engineer. State what`,
      "failed, the likely cause if evident from the logs, and any suggested next step. Be concise.",
      input.release ? `\nRelease: ${input.release.version} (${input.release.environment})` : "",
      "\nLogs:",
      input.logs,
    ]
      .filter((line) => line !== "")
      .join("\n")
  );
}
