import type { GithubDirEntry, GithubProvider } from "./types.js";
import { fillVersionPlaceholders, replaceMarkdownSection } from "../releaseNotes.js";

export const RELEASE_PR_TEMPLATE_DIR = ".github/PULL_REQUEST_TEMPLATE";

export const DEFAULT_PR_TEMPLATE_PATHS = [
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
  "PULL_REQUEST_TEMPLATE.md",
] as const;

export interface LoadedPrTemplate {
  path: string;
  text: string;
}

export function pickReleaseTemplateFile(entries: GithubDirEntry[]): GithubDirEntry | undefined {
  const files = entries.filter((e) => e.type === "file" && e.name.toLowerCase().endsWith(".md"));
  const exact = files.find((e) => e.name.toLowerCase() === "release.md");
  if (exact) return exact;
  return files.find((e) => /release/i.test(e.name));
}

/**
 * Prefers `.github/PULL_REQUEST_TEMPLATE/release.md` (any filename matching /release/i),
 * then GitHub's default pull_request_template.md locations.
 */
export async function loadReleasePrTemplate(
  github: GithubProvider,
  input: { owner: string; repo: string; ref: string }
): Promise<LoadedPrTemplate | undefined> {
  const dir = await github.listDirectory({
    owner: input.owner,
    repo: input.repo,
    path: RELEASE_PR_TEMPLATE_DIR,
    ref: input.ref,
  });
  const picked = pickReleaseTemplateFile(dir);
  if (picked) {
    const text = await github.readFile({
      owner: input.owner,
      repo: input.repo,
      path: picked.path,
      ref: input.ref,
    });
    if (text !== undefined) return { path: picked.path, text };
  }

  for (const path of DEFAULT_PR_TEMPLATE_PATHS) {
    const text = await github.readFile({
      owner: input.owner,
      repo: input.repo,
      path,
      ref: input.ref,
    });
    if (text !== undefined) return { path, text };
  }
  return undefined;
}

export function fillReleasePrBody(options: {
  template?: string;
  version: string;
  environment: string;
  repo: string;
  head: string;
  base: string;
  /** Formatted release-note lines (ticket, title, PR). */
  releaseNotes?: string;
  /** Commit/ticket scope already formatted as markdown. */
  includedWork?: string;
}): string {
  const vars: Record<string, string> = {
    version: options.version,
    environment: options.environment,
    repo: options.repo,
    head: options.head,
    base: options.base,
    releaseBranch: options.head,
    sourceBranch: options.base,
  };
  let body = options.template?.trim() ?? "";
  for (const [key, value] of Object.entries(vars)) {
    body = body.replaceAll(`{{${key}}}`, value);
    body = body.replaceAll(`{{ ${key} }}`, value);
  }
  if (body.length > 0) {
    body = fillVersionPlaceholders(body, options.version);
  }
  const notes = options.releaseNotes?.trim();
  if (notes) {
    body = body.length > 0 ? replaceMarkdownSection(body, "Release notes", notes) : notes;
  }
  const extra = options.includedWork?.trim();
  if (extra && !notes && !body.includes(extra)) {
    body = body.length > 0 ? `${body}\n\n${extra}` : extra;
  }
  if (body.length === 0) {
    body = `Release ${options.version}: merge \`${options.head}\` into \`${options.base}\`.`;
  }
  return body;
}

const RELEASE_TICKET_HEADINGS = ["Ticket", "Change ticket", "PCM ticket", "Jira ticket", "Release ticket"];

function ticketDisplay(ticketId: string, ticketUrl?: string): string {
  const url = ticketUrl?.trim();
  return url ? `[${ticketId}](${url})` : ticketId;
}

function insertAfterVersionSection(body: string, section: string): string {
  const headingRe = /^(#{1,3}\s*Version\s*)$/im;
  const match = headingRe.exec(body);
  if (!match) {
    return `${section}\n\n${body}`.trimStart();
  }
  const start = match.index + match[0].length;
  const rest = body.slice(start);
  const nextHeading = rest.search(/\n#{1,3}\s+\S/);
  if (nextHeading === -1) {
    return `${body.trimEnd()}\n\n${section}\n`;
  }
  const insertAt = start + nextHeading;
  return `${body.slice(0, insertAt)}\n${section}\n${body.slice(insertAt)}`;
}

/** Write the PCM/change-ticket key into an existing release PR body. */
export function applyReleaseTicketToPrBody(
  body: string,
  ticket: { id: string; url?: string }
): string {
  const ticketId = ticket.id.trim();
  if (!ticketId) return body;
  const display = ticketDisplay(ticketId, ticket.url);
  let next = body
    .replaceAll("{{ticket}}", display)
    .replaceAll("{{ ticket }}", display)
    .replaceAll("{{ticketId}}", ticketId)
    .replaceAll("{{ ticketId }}", ticketId)
    .replaceAll("{{ticketUrl}}", ticket.url?.trim() ?? ticketId)
    .replaceAll("{{ ticketUrl }}", ticket.url?.trim() ?? ticketId);

  const project = ticketId.split("-")[0];
  if (project) {
    next = next.replaceAll(`${project}-XXXX`, display);
  }

  for (const heading of RELEASE_TICKET_HEADINGS) {
    const headingRe = new RegExp(`^#{1,3}\\s*${heading}\\s*$`, "im");
    if (headingRe.test(next)) {
      return replaceMarkdownSection(next, heading, display);
    }
  }

  if (new RegExp(`\\b${ticketId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(next)) return next;
  return insertAfterVersionSection(next, `## Ticket\n\n${display}`);
}
