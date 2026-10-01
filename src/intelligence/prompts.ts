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
  "Base your output ONLY on the information given to you in the user message. Do not invent",
  "ticket IDs, approver names, commit hashes, dates, metrics, percentages, technology names,",
  "feature flag names, or any other specific fact not present in the input — not even plausible-",
  "sounding ones. If the input doesn't give you enough detail to be specific, say so plainly and",
  "write generic placeholder language instead (e.g. \"this release updates the listed",
  "repositories — see linked commits/PRs for details\"). A vague-but-true draft is always better",
  "than a specific-but-invented one.",
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

const JSON_ARRAY_INSTRUCTION =
  "Respond with ONLY a JSON array of strings, nothing else — no explanation, no markdown fences.";

export function ticketDescriptionPrompt(input: TicketDescriptionInput): ChatMessage[] {
  const ticketLines = (input.tickets ?? []).map((t) => {
    const brief = t.description?.trim() ? `: ${t.description.trim()}` : "";
    return `  - ${t.key} — ${t.summary}${brief}`;
  });

  return withSystem(
    [
      "Draft a change-management ticket description for the following release.",
      "Write 2-4 short paragraphs or a short paragraph plus a bullet list of notable changes.",
      "Do not include a title or ticket ID field — just the description body.",
      "If a list of included tickets is provided, mention each key and title. Do not invent tickets.",
      "",
      releaseSummaryBlock(input.release),
      ticketLines.length > 0 ? `\nTickets included in this release:\n${ticketLines.join("\n")}` : "",
      input.context
        ? `\nAdditional context:\n${input.context}`
        : ticketLines.length > 0
          ? ""
          : "\n(No change details were provided beyond the above. Do not invent any — keep the " +
            "description generic and note that specific changes should be filled in by the author.)",
    ]
      .filter((line) => line !== "")
      .join("\n")
  );
}

export function extractTicketKeysPrompt(input: { commits: { sha: string; message: string }[] }): ChatMessage[] {
  const commitLines = input.commits.map((c) => `  - ${c.sha.slice(0, 8)} ${c.message}`);
  return withSystem(
    [
      "Extract Jira issue keys from the commit messages below. Keys look like PCM-123 or PROJ-9.",
      JSON_ARRAY_INSTRUCTION,
      "Return each distinct key once. If none are present, return [].",
      "",
      "Commits:",
      ...commitLines,
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
      input.changesSummary
        ? `\nChange summary to draw from:\n${input.changesSummary}`
        : "\n(No change summary was provided. Do not invent any — keep the notes generic and " +
          "note that specific changes should be filled in by the author.)",
    ].join("\n")
  );
}

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
