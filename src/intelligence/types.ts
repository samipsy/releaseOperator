import type { Release } from "../types.js";

/**
 * IntelligenceProvider is purely advisory: every method returns drafted/summarized text
 * for a human to review. Nothing in this interface reads or writes ReleaseState, decides
 * approvals, or gates a deployment — see src/engine.ts for the actual, deterministic
 * workflow. Callers are responsible for what (if anything) they do with the output.
 */
export interface IntelligenceProvider {
  generateTicketDescription(input: TicketDescriptionInput): Promise<string>;
  extractTicketKeys(input: ExtractTicketKeysInput): Promise<string[]>;
  summarizeChanges(input: ChangeSummaryInput): Promise<string>;
  generateReleaseNotes(input: ReleaseNotesInput): Promise<string>;
  identifyAffectedComponents(input: AffectedComponentsInput): Promise<string[]>;
  suggestSanityTests(input: SanityTestSuggestionInput): Promise<string[]>;
  summarizeFailure(input: FailureSummaryInput): Promise<string>;
}

export interface TicketDescriptionInput {
  release: Release;
  /** Free-form extra context: notable commits, scope notes, links, etc. */
  context?: string;
  /** Tickets parsed from release-branch commits, with Jira title/summary filled in. */
  tickets?: { key: string; summary: string; description?: string }[];
}

export interface ExtractTicketKeysInput {
  commits: CommitInfo[];
}

export interface CommitInfo {
  sha: string;
  message: string;
  author?: string;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  body?: string;
  url?: string;
}

export interface ChangeSummaryInput {
  release?: Release;
  commits: CommitInfo[];
  pullRequests?: PullRequestInfo[];
}

export interface ReleaseNotesInput {
  release: Release;
  /** Typically the output of summarizeChanges(), or any other free-form change context. */
  changesSummary?: string;
}

export interface AffectedComponentsInput {
  release: Release;
  changedFiles?: string[];
  context?: string;
}

export interface SanityTestSuggestionInput {
  release: Release;
  changedFiles?: string[];
  context?: string;
}

export type FailureKind = "ci" | "deployment" | "test" | "sanity";

export interface FailureSummaryInput {
  release?: Release;
  kind: FailureKind;
  logs: string;
}
