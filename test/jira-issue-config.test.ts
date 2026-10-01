import { describe, expect, it } from "vitest";
import { JiraServiceError } from "../src/errors.js";
import { jiraIssueCreateConfigFromEnv } from "../src/jira/issueConfig.js";

describe("jiraIssueCreateConfigFromEnv", () => {
  it("reads parent Epic from PARENT_KEY or EPIC_KEY", () => {
    expect(jiraIssueCreateConfigFromEnv({ RELEASE_OPERATOR_JIRA_PARENT_KEY: "PCM-10" }).parentKey).toBe("PCM-10");
    expect(jiraIssueCreateConfigFromEnv({ RELEASE_OPERATOR_JIRA_EPIC_KEY: " PCM-11 " }).parentKey).toBe("PCM-11");
  });

  it("parses extra fields JSON", () => {
    const cfg = jiraIssueCreateConfigFromEnv({
      RELEASE_OPERATOR_JIRA_EXTRA_FIELDS: '{"labels":["release"],"customfield_10014":"PCM-10"}',
    });
    expect(cfg.extraFields).toEqual({ labels: ["release"], customfield_10014: "PCM-10" });
  });

  it("rejects non-object extra fields", () => {
    expect(() => jiraIssueCreateConfigFromEnv({ RELEASE_OPERATOR_JIRA_EXTRA_FIELDS: "[1]" })).toThrow(JiraServiceError);
  });
});
