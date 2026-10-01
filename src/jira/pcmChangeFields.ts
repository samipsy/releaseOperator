import type { Release } from "../types.js";
import type { ReleaseBump } from "../versioning.js";
import { uniqueTicketKeys } from "../intelligence/ticketKeys.js";
import {
  displayReleaseVersion,
  formatTicketCell,
  type ReleaseChange,
} from "../releaseNotes.js";
import { toJiraDate, toJiraDateTime } from "./plannedWindow.js";
import { netlifyProjectsForRepos } from "../netlify/repoProjects.js";

export const PCM_ENVIRONMENTS_AFFECTED = "Prod - US/MX";
export const PCM_IMPLEMENTATION_PLAN_FIELD = "customfield_10130";
export const PCM_ROLLBACK_PLAN_FIELD = "customfield_10486";
export const PCM_AFFECTED_SERVICES_FIELD = "customfield_10081";

/** Prefix used when no Netlify projects are mapped for the repo. */
export const PCM_DEFAULT_ROLLBACK_PLAN = "Redeploy prev versions";

/** JSM Affected services: always "Beauty Quiz" for now. ARI from PCM Beauty Quiz tickets (e.g. PCM-1973). */
export const PCM_AFFECTED_SERVICE_NAME = "Beauty Quiz";
export const PCM_AFFECTED_SERVICE_ARI =
  "ari:cloud:graph::service/2ace2c0c-09ec-11eb-a2b6-0a77f3f45304/eaf80cb8-40cd-11ed-99a0-0abe3f4a6601";

export const PCM_CHANGE_LABELS = ["CAB-Bug-Fix", "CAB-MX", "CAB-NewPlatform", "CAB-US/CA"] as const;
export const PCM_ISSUE_LINK_TYPE = "Relates";
export const PCM_CHANGE_APPLIED_STATUS = "Change Applied";

export function isPcmChangeApplied(status?: string): boolean {
  return status?.trim().toLowerCase() === PCM_CHANGE_APPLIED_STATUS.toLowerCase();
}

/** PCM Change approvers (Jira account ids). Override via RELEASE_OPERATOR_JIRA_EXTRA_FIELDS if needed. */
export const PCM_MANAGER_APPROVER_ACCOUNT_ID = "712020:513c297c-9b9c-412d-8284-64916ffa483a";
export const PCM_SLT_APPROVER_ACCOUNT_IDS = [
  "614b952caea6880072683cf0",
  "712020:0d6a2996-1d4f-4d40-a022-bbf4adf28bca",
] as const;

export function changeReasonOneLiner(options: { bump: ReleaseBump; repo: string; version: string }): string {
  return `New release of ${options.repo} to ${options.version}`;
}

function changeReasonSelect(bump: ReleaseBump): string {
  if (bump === "major") return "Upgrade";
  if (bump === "minor") return "New functionality";
  return "Maintenance";
}

function userPicker(accountId: string): { accountId: string } {
  return { accountId };
}

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}

/** Human-readable system name for PCM description (e.g. blog-microfrontend → Blog MFE). */
export function displaySystemName(repo: string): string {
  const trimmed = repo.trim();
  const isMfe = /[-_]?microfrontend$/i.test(trimmed);
  const base = trimmed.replace(/[-_]?microfrontend$/i, "").replace(/[-_]/g, " ").trim();
  const titled = base
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
  if (isMfe || /^landings$/i.test(trimmed)) return titled ? `${titled} MFE` : "MFE";
  return titled || trimmed;
}

export function pcmChangeDescriptionOneLiner(options: {
  version: string;
  repo: string;
  changeTitles: string[];
}): string {
  const system = displaySystemName(options.repo);
  const version = displayReleaseVersion(options.version);
  const titles = [...new Set(options.changeTitles.map((t) => t.trim()).filter(Boolean))];
  if (titles.length > 0) {
    return `Release ${version} for ${system} to address the following tickets`;
  }
  return `Release ${version} for ${system}`;
}

export function formatPcmTicketRow(change: ReleaseChange): string {
  const ticket = change.ticketKey ? formatTicketCell(change.ticketKey, change.ticketUrl) : "";
  const description = cell(change.title.trim() || "(no title)");
  const pr = cell(change.prUrl ?? (typeof change.prNumber === "number" ? `#${change.prNumber}` : ""));
  return `| ${ticket} | ${description} | ${pr} |`;
}

export function formatPcmTicketTable(changes: ReleaseChange[]): string {
  const rows = changes.length > 0 ? changes.map(formatPcmTicketRow) : ["|  | (no merged tickets found) |  |"];
  return ["| Ticket | Description | PRs |", "| --- | --- | --- |", ...rows].join("\n");
}

export function pcmLinkedTicketKeys(changes: ReleaseChange[]): string[] {
  return uniqueTicketKeys(changes.flatMap((change) => (change.ticketKey ? [change.ticketKey] : [])));
}

/** PCM Change description — why / ticket table / env / systems (not Jira custom fields). */
export function formatPcmTicketDescription(options: {
  version: string;
  repo: string;
  changes: ReleaseChange[];
  environmentsAffected?: string;
}): string {
  const oneLiner = pcmChangeDescriptionOneLiner({
    version: options.version,
    repo: options.repo,
    changeTitles: options.changes.map((c) => c.title),
  });
  const env = options.environmentsAffected ?? PCM_ENVIRONMENTS_AFFECTED;
  return [
    "**Why Change is Needed/Change Description:**",
    "",
    oneLiner,
    "",
    formatPcmTicketTable(options.changes),
    "",
    `**Environment(s) Affected:** ${env}`,
    "",
    `**Systems/Applications Impacted:** ${displaySystemName(options.repo)}`,
  ].join("\n");
}

export function releasePrUrls(release: Release): string[] {
  return release.repos.map((repo) => repo.releasePrUrl).filter((url): url is string => Boolean(url));
}

export function pcmImplementationPlan(release: Release): string | undefined {
  const urls = releasePrUrls(release);
  if (urls.length === 0) return undefined;
  return urls.join("\n");
}

/** Rollback plan: Netlify US/MX sites for the release repos (live deploy URLs come later). */
export function pcmRollbackPlan(release: Release): string {
  const lines = [PCM_DEFAULT_ROLLBACK_PLAN];
  for (const projects of netlifyProjectsForRepos(release.repos.map((repo) => repo.name))) {
    lines.push(`US: https://${projects.us.site}`);
    lines.push(`MX: https://${projects.mx.site}`);
  }
  return lines.join("\n");
}

/**
 * PCM Change required workflow fields (risk, reason select, dates, approvers,
 * implementation plan, rollback plan, affected services).
 */
export function buildPcmChangeFields(
  release: Release,
  options: { accountId?: string; rollbackPlan?: string } = {}
): Record<string, unknown> {
  const bump = release.bump ?? "patch";
  const implementation = pcmImplementationPlan(release);

  const fields: Record<string, unknown> = {
    customfield_10035: { value: changeReasonSelect(bump) },
    customfield_10034: { value: "Low" },
    customfield_10038: { value: "Low" },
    customfield_10483: { value: "Application" },
    [PCM_ROLLBACK_PLAN_FIELD]: options.rollbackPlan ?? pcmRollbackPlan(release),
    [PCM_AFFECTED_SERVICES_FIELD]: [{ id: PCM_AFFECTED_SERVICE_ARI }],
    labels: [...PCM_CHANGE_LABELS],
    customfield_10488: [userPicker(PCM_MANAGER_APPROVER_ACCOUNT_ID)],
    customfield_10485: PCM_SLT_APPROVER_ACCOUNT_IDS.map(userPicker),
  };

  if (implementation) {
    fields[PCM_IMPLEMENTATION_PLAN_FIELD] = implementation;
  }

  if (release.plannedStart) {
    fields.customfield_10133 = toJiraDateTime(release.plannedStart);
    fields.duedate = toJiraDate(release.plannedStart);
  }
  if (release.plannedEnd) {
    fields.customfield_10134 = toJiraDateTime(release.plannedEnd);
  }
  if (options.accountId) {
    fields.assignee = userPicker(options.accountId);
    fields.reporter = userPicker(options.accountId);
  }
  return fields;
}
