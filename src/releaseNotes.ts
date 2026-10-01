/** Shared markdown table of release changes for the GitHub PR and (later) the PCM ticket. */

export interface ReleaseChange {
  ticketKey?: string;
  /** Jira browse URL when known. */
  ticketUrl?: string;
  title: string;
  author?: string;
  prNumber?: number;
  /** Feature PR URL when known (PCM description uses the full URL). */
  prUrl?: string;
}

export function displayReleaseVersion(version: string): string {
  const trimmed = version.trim();
  if (!trimmed) return trimmed;
  return /^v/i.test(trimmed) ? trimmed : `v${trimmed}`;
}

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}

function escapeHtmlAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

/** Keep KEY-123 on one line (hyphens otherwise wrap) and link to Jira when we have a URL. */
export function formatTicketCell(key: string, url?: string): string {
  const label = key.replaceAll("-", "&#8209;");
  if (url) {
    return `<a href="${escapeHtmlAttr(url)}"><span style="white-space:nowrap">${label}</span></a>`;
  }
  return `<span style="white-space:nowrap">${label}</span>`;
}

export function formatReleaseNoteRow(change: ReleaseChange): string {
  const ticket = change.ticketKey ? formatTicketCell(change.ticketKey, change.ticketUrl) : "";
  const title = change.title.trim() || "(no title)";
  const authorRaw = change.author?.replace(/^@/, "").trim();
  const author = authorRaw ? `@${authorRaw}` : "";
  const pr = typeof change.prNumber === "number" ? `#${change.prNumber}` : "";
  return `| ${ticket} | ${cell(title)} | ${cell(author)} | ${cell(pr)} |`;
}

/** @deprecated use formatReleaseNoteRow — kept as an alias for the table row. */
export function formatReleaseNoteLine(change: ReleaseChange): string {
  return formatReleaseNoteRow(change);
}

export function formatReleaseNotesBlock(changes: ReleaseChange[]): string {
  if (changes.length === 0) {
    return "No merged changes were found between the merge target and the release branch.";
  }
  return [
    "| Ticket # | Title | Author | PR # |",
    "| --- | --- | --- | --- |",
    ...changes.map(formatReleaseNoteRow),
  ].join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace vX.X.X / {{version}} style placeholders with the computed version. */
export function fillVersionPlaceholders(text: string, version: string): string {
  const display = displayReleaseVersion(version);
  return text
    .replaceAll("{{version}}", version)
    .replaceAll("{{ version }}", version)
    .replace(/\bvX\.X\.X\b/gi, display)
    .replace(/\bvX\.Y\.Z\b/gi, display);
}

/**
 * Replace the body of a markdown heading (through the next heading) with `content`.
 * If the heading is missing, appends it.
 */
export function replaceMarkdownSection(body: string, heading: string, content: string): string {
  const headingRe = new RegExp(`^(#{1,3}\\s*${escapeRegExp(heading)}\\s*)$`, "im");
  const match = headingRe.exec(body);
  if (!match) {
    return `${body.trimEnd()}\n\n## ${heading}\n\n${content}\n`;
  }
  const headingLine = match[0];
  const start = match.index + headingLine.length;
  const rest = body.slice(start);
  const nextHeading = rest.search(/\n#{1,3}\s+\S/);
  const before = body.slice(0, match.index);
  const after = nextHeading === -1 ? "" : rest.slice(nextHeading);
  return `${before}${headingLine}\n\n${content}\n${after}`;
}
