import { describe, expect, it, vi } from "vitest";
import { SlackServiceError } from "../src/errors.js";
import { classifyThreadReplies } from "../src/slack/parseApproval.js";
import { resolveSlackApprovalEvent } from "../src/slack/ingestApprovals.js";
import { SlackRestProvider, slackMessagePermalink } from "../src/slack/slackRestProvider.js";
import type { SlackProvider } from "../src/slack/types.js";
import type { Release } from "../src/types.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function pendingRelease(overrides?: Partial<Release>): Release {
  const now = new Date();
  return {
    id: "rel-1",
    version: "1.0.0",
    state: "QA_APPROVAL_PENDING",
    repos: [{ name: "web", sourceBranch: "main" }],
    environment: "prod",
    approvals: {
      qa: { status: "pending", slackChannel: "C123", slackTs: "1710000000.000100" },
    },
    ci: { status: "unknown" },
    featureFlags: [],
    createdBy: "sam",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("slackMessagePermalink", () => {
  it("builds an archives URL from channel and ts", () => {
    expect(slackMessagePermalink("C123", "1712345678.123456")).toBe(
      "https://slack.com/archives/C123/p1712345678123456"
    );
  });
});

describe("SlackRestProvider", () => {
  it("posts a message and parses ts/channel", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, ts: "1710000000.000100", channel: "C123" })
    );
    const provider = new SlackRestProvider({ token: "xoxb-test", fetchImpl });
    const result = await provider.postMessage({ channel: "C123", text: "hello" });
    expect(result).toEqual({
      ts: "1710000000.000100",
      channel: "C123",
      url: "https://slack.com/archives/C123/p1710000000000100",
    });
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://slack.com/api/chat.postMessage");
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({
      channel: "C123",
      text: "hello",
    });
  });

  it("throws SlackServiceError when ok is false", async () => {
    const fetchImpl = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse({ ok: false, error: "not_in_channel" }))
    );
    const provider = new SlackRestProvider({ token: "xoxb-test", fetchImpl });
    await expect(provider.postMessage({ channel: "C123", text: "hello" })).rejects.toThrow(SlackServiceError);
    await expect(provider.postMessage({ channel: "C123", text: "hello" })).rejects.toThrow(/not_in_channel/);
  });

  it("lists thread replies and loads a user display name", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          messages: [
            { ts: "1.0", text: "parent", user: "B0" },
            { ts: "1.1", text: "approved", user: "U1" },
          ],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          user: { id: "U1", profile: { display_name: "qa-lead" } },
        })
      );
    const provider = new SlackRestProvider({ token: "xoxb-test", fetchImpl });
    const replies = await provider.listThreadReplies({ channel: "C123", ts: "1.0" });
    expect(replies).toHaveLength(2);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("conversations.replies");
    expect(await provider.getUser("U1")).toEqual({ id: "U1", name: "qa-lead" });
  });
});

describe("classifyThreadReplies", () => {
  it("ignores the parent and bot messages, then takes the first approve or reject", () => {
    expect(
      classifyThreadReplies(
        [
          { ts: "1.0", text: "please approve", user: "Ubot", botId: "B1" },
          { ts: "1.0", text: "parent", user: "Ubot" },
          { ts: "1.1", text: "looking now", user: "U1" },
          { ts: "1.2", text: "approved", user: "U2" },
        ],
        "1.0"
      )
    ).toEqual({ kind: "approve", userId: "U2", text: "approved" });
  });

  it("treats reject as a verdict", () => {
    expect(
      classifyThreadReplies([{ ts: "1.1", text: "reject — missing tests", user: "U9" }], "1.0")
    ).toEqual({ kind: "reject", userId: "U9", text: "reject — missing tests" });
  });

  it("treats approval and a tick mark as approve", () => {
    expect(classifyThreadReplies([{ ts: "1.1", text: "approval", user: "U3" }], "1.0")).toEqual({
      kind: "approve",
      userId: "U3",
      text: "approval",
    });
    expect(classifyThreadReplies([{ ts: "1.1", text: "✅", user: "U4" }], "1.0")).toEqual({
      kind: "approve",
      userId: "U4",
      text: "✅",
    });
    expect(classifyThreadReplies([{ ts: "1.1", text: ":white_check_mark:", user: "U5" }], "1.0")).toEqual({
      kind: "approve",
      userId: "U5",
      text: ":white_check_mark:",
    });
  });
});

describe("resolveSlackApprovalEvent", () => {
  it("returns QA_APPROVED with the Slack display name", async () => {
    const slack: SlackProvider = {
      postMessage: vi.fn(),
      listThreadReplies: vi.fn().mockResolvedValue([
        { ts: "1710000000.000100", text: "need QA", user: "B0", botId: "B0" },
        { ts: "1710000000.000200", text: "lgtm", user: "U99" },
      ]),
      getUser: vi.fn().mockResolvedValue({ id: "U99", name: "qa-lead" }),
      authTest: vi.fn(),
    };
    const result = await resolveSlackApprovalEvent({
      release: pendingRelease(),
      slack,
      actor: "cli",
    });
    expect(result.status).toBe("event");
    if (result.status !== "event") return;
    expect(result.event).toEqual({
      type: "QA_APPROVED",
      actor: "cli",
      payload: { approvedBy: "qa-lead", notes: "lgtm" },
    });
  });

  it("no-ops when the thread has no verdict yet", async () => {
    const slack: SlackProvider = {
      postMessage: vi.fn(),
      listThreadReplies: vi.fn().mockResolvedValue([
        { ts: "1710000000.000100", text: "need QA", botId: "B0" },
        { ts: "1710000000.000200", text: "looking", user: "U1" },
      ]),
      getUser: vi.fn(),
      authTest: vi.fn(),
    };
    const result = await resolveSlackApprovalEvent({
      release: pendingRelease(),
      slack,
      actor: "cli",
    });
    expect(result.status).toBe("noop");
  });
});

