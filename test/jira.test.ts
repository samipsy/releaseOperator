import { describe, it, expect, vi } from "vitest";
import { JiraMcpProvider } from "../src/jira/jiraMcpProvider.js";
import { JiraServiceError } from "../src/errors.js";
import type { McpToolCaller } from "../src/mcp/types.js";

const ACCESSIBLE_RESOURCES = {
  data: {
    resources: [
      { cloudId: "cloud-care", url: "https://ipsycare.atlassian.net", products: [{ id: "confluence" }] },
      {
        cloudId: "cloud-corp",
        url: "https://ipsycorp.atlassian.net",
        products: [{ id: "confluence" }, { id: "jira" }, { id: "jsm" }],
      },
    ],
  },
};

function textResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

function makeCaller(responses: Record<string, { content: { type: string; text?: string }[]; isError?: boolean }>): McpToolCaller & {
  callTool: ReturnType<typeof vi.fn>;
} {
  const callTool = vi.fn().mockImplementation(({ name }: { name: string }) => {
    if (!(name in responses)) throw new Error(`unexpected tool call: ${name}`);
    return Promise.resolve(responses[name]);
  });
  return { callTool };
}

describe("JiraMcpProvider.createIssue", () => {
  it("resolves cloudId by matching the configured site, then creates the issue", async () => {
    const caller = makeCaller({
      getAccessibleAtlassianResources: textResult(JSON.stringify(ACCESSIBLE_RESOURCES)),
      createJiraIssue: textResult(JSON.stringify({ data: { key: "PCM-42" } })),
    });
    const provider = new JiraMcpProvider({ caller, siteUrl: "https://ipsycorp.atlassian.net/" });

    const result = await provider.createIssue({
      projectKey: "PCM",
      summary: "Release 1.0.0 (prod)",
      issueType: "Task",
      description: "Body text",
    });

    expect(result).toEqual({ key: "PCM-42", url: "https://ipsycorp.atlassian.net/browse/PCM-42", raw: expect.any(String) });
    expect(caller.callTool).toHaveBeenCalledWith({
      name: "createJiraIssue",
      arguments: {
        cloudId: "cloud-corp",
        projectKey: "PCM",
        summary: "Release 1.0.0 (prod)",
        issueType: "Task",
        description: "Body text",
      },
    });
  });

  it("extracts the issue key from free-form MCP text when JSON has no key field", async () => {
    const caller = makeCaller({
      getAccessibleAtlassianResources: textResult(JSON.stringify(ACCESSIBLE_RESOURCES)),
      createJiraIssue: textResult("Created issue PCM-77 in project PCM"),
    });
    const provider = new JiraMcpProvider({ caller, siteUrl: "https://ipsycorp.atlassian.net" });

    const result = await provider.createIssue({
      projectKey: "PCM",
      summary: "Release 1.0.0 (prod)",
      issueType: "Task",
    });

    expect(result.key).toBe("PCM-77");
    expect(result.url).toBe("https://ipsycorp.atlassian.net/browse/PCM-77");
  });

  it("resolves cloudId only once across multiple calls", async () => {
    const caller = makeCaller({
      getAccessibleAtlassianResources: textResult(JSON.stringify(ACCESSIBLE_RESOURCES)),
      createJiraIssue: textResult(JSON.stringify({ data: { key: "PCM-1" } })),
    });
    const provider = new JiraMcpProvider({ caller, siteUrl: "https://ipsycorp.atlassian.net" });

    await provider.createIssue({ projectKey: "PCM", summary: "a", issueType: "Task" });
    await provider.createIssue({ projectKey: "PCM", summary: "b", issueType: "Task" });

    const resourceCalls = caller.callTool.mock.calls.filter((c) => c[0].name === "getAccessibleAtlassianResources");
    expect(resourceCalls).toHaveLength(1);
  });

  it("throws JiraServiceError when no accessible site matches the configured siteUrl", async () => {
    const caller = makeCaller({ getAccessibleAtlassianResources: textResult(JSON.stringify(ACCESSIBLE_RESOURCES)) });
    const provider = new JiraMcpProvider({ caller, siteUrl: "https://nonexistent.atlassian.net" });

    await expect(provider.createIssue({ projectKey: "PCM", summary: "a", issueType: "Task" })).rejects.toThrow(
      JiraServiceError
    );
  });

  it("throws JiraServiceError when the matched site has no Jira product access", async () => {
    const caller = makeCaller({ getAccessibleAtlassianResources: textResult(JSON.stringify(ACCESSIBLE_RESOURCES)) });
    const provider = new JiraMcpProvider({ caller, siteUrl: "https://ipsycare.atlassian.net" });

    await expect(provider.createIssue({ projectKey: "PCM", summary: "a", issueType: "Task" })).rejects.toThrow(
      /no Jira product access/
    );
  });

  it("throws JiraServiceError when createJiraIssue reports failure", async () => {
    const caller = makeCaller({
      getAccessibleAtlassianResources: textResult(JSON.stringify(ACCESSIBLE_RESOURCES)),
      createJiraIssue: textResult("issueType: invalid value, allowed: Task, Bug, Story", true),
    });
    const provider = new JiraMcpProvider({ caller, siteUrl: "https://ipsycorp.atlassian.net" });

    await expect(
      provider.createIssue({ projectKey: "PCM", summary: "a", issueType: "NotAType" })
    ).rejects.toThrow(/allowed: Task/);
  });
});

describe("JiraMcpProvider.addComment", () => {
  it("resolves cloudId then posts the comment", async () => {
    const caller = makeCaller({
      getAccessibleAtlassianResources: textResult(JSON.stringify(ACCESSIBLE_RESOURCES)),
      addOrEditJiraIssueComment: textResult(JSON.stringify({ data: { id: "10050" } })),
    });
    const provider = new JiraMcpProvider({ caller, siteUrl: "https://ipsycorp.atlassian.net" });

    const result = await provider.addComment({ issueKey: "PCM-42", body: "Release notes here." });

    expect(result.raw).toContain("10050");
    expect(caller.callTool).toHaveBeenCalledWith({
      name: "addOrEditJiraIssueComment",
      arguments: { cloudId: "cloud-corp", issueIdOrKey: "PCM-42", commentBody: "Release notes here." },
    });
  });
});
