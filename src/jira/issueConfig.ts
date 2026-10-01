import { JiraServiceError } from "../errors.js";

export interface JiraIssueCreateConfig {
  parentKey?: string;
  extraFields: Record<string, unknown>;
}

/**
 * Org-stable Jira create fields from env. Not secrets: project/epic/custom field *keys*.
 * Extra fields are a JSON object merged into Jira `fields` (e.g. Epic Link customfield).
 */
export function jiraIssueCreateConfigFromEnv(
  env: NodeJS.Dict<string> = process.env
): JiraIssueCreateConfig {
  const parentKey = optionalString(env.RELEASE_OPERATOR_JIRA_PARENT_KEY ?? env.RELEASE_OPERATOR_JIRA_EPIC_KEY);
  return {
    ...(parentKey ? { parentKey } : {}),
    extraFields: parseExtraFields(env.RELEASE_OPERATOR_JIRA_EXTRA_FIELDS),
  };
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function parseExtraFields(raw: string | undefined): Record<string, unknown> {
  const text = raw?.trim();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new JiraServiceError(
      `RELEASE_OPERATOR_JIRA_EXTRA_FIELDS is not valid JSON: ${(err as Error).message}`,
      err
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new JiraServiceError("RELEASE_OPERATOR_JIRA_EXTRA_FIELDS must be a JSON object of Jira fields.");
  }
  return parsed as Record<string, unknown>;
}
