import type { Release, ReleaseEvent, ReleaseState } from "../types.js";
import { classifyThreadReplies } from "./parseApproval.js";
import type { SlackProvider, SlackThreadMessage } from "./types.js";

export const SLACK_APPROVAL_PENDING_STATES = new Set<ReleaseState>([
  "QA_APPROVAL_PENDING",
  "CAB_APPROVAL_PENDING",
  "PREPROD_APPROVAL_PENDING",
]);

export function isSlackApprovalPending(release: Release): boolean {
  return SLACK_APPROVAL_PENDING_STATES.has(release.state);
}

export type SlackIngestResult =
  | { status: "noop"; reason: string; replies: SlackThreadMessage[] }
  | { status: "event"; event: ReleaseEvent; replies: SlackThreadMessage[] };

async function displayName(slack: SlackProvider, userId: string): Promise<string> {
  try {
    const user = await slack.getUser(userId);
    const name = user?.name?.trim();
    return name && name.length > 0 ? name : userId;
  } catch {
    return userId;
  }
}

/**
 * Reads the stored QA/CAB Slack thread and, if a human replied approve/reject, returns the
 * matching engine event. Does not call the engine — the CLI does that.
 */
export async function resolveSlackApprovalEvent(options: {
  release: Release;
  slack: SlackProvider;
  actor: string;
}): Promise<SlackIngestResult> {
  const { release, slack, actor } = options;
  const kind =
    release.state === "QA_APPROVAL_PENDING"
      ? "qa"
      : release.state === "CAB_APPROVAL_PENDING"
        ? "cab"
        : release.state === "PREPROD_APPROVAL_PENDING"
          ? "preprod"
          : undefined;
  if (!kind) {
    return {
      status: "noop",
      reason: `Release is in ${release.state}, not QA_APPROVAL_PENDING, CAB_APPROVAL_PENDING, or PREPROD_APPROVAL_PENDING`,
      replies: [],
    };
  }
  const approval =
    kind === "qa" ? release.approvals.qa : kind === "cab" ? release.approvals.cab : release.approvals.preprod;
  const channel = approval?.slackChannel;
  const ts = approval?.slackTs;
  if (!channel || !ts) {
    return {
      status: "noop",
      reason: `No Slack thread stored on this release's ${kind.toUpperCase()} approval — was Slack configured when the request was posted?`,
      replies: [],
    };
  }

  const replies = await slack.listThreadReplies({ channel, ts });
  const verdict = classifyThreadReplies(replies, ts);
  if (verdict.kind === "none") {
    return { status: "noop", reason: "No approve/reject reply found in the Slack thread yet", replies };
  }

  const approvedBy = await displayName(slack, verdict.userId);
  if (kind === "qa") {
    if (verdict.kind === "approve") {
      return {
        status: "event",
        replies,
        event: { type: "QA_APPROVED", actor, payload: { approvedBy, notes: verdict.text } },
      };
    }
    return {
      status: "event",
      replies,
      event: { type: "QA_REJECTED", actor, payload: { rejectedBy: approvedBy, notes: verdict.text } },
    };
  }
  if (kind === "preprod") {
    if (verdict.kind === "approve") {
      return {
        status: "event",
        replies,
        event: { type: "PREPROD_APPROVED", actor, payload: { approvedBy, notes: verdict.text } },
      };
    }
    return {
      status: "event",
      replies,
      event: { type: "PREPROD_REJECTED", actor, payload: { rejectedBy: approvedBy, notes: verdict.text } },
    };
  }
  if (verdict.kind === "approve") {
    return {
      status: "event",
      replies,
      event: { type: "CAB_APPROVED", actor, payload: { approvedBy, notes: verdict.text } },
    };
  }
  return {
    status: "event",
    replies,
    event: { type: "CAB_REJECTED", actor, payload: { rejectedBy: approvedBy, notes: verdict.text } },
  };
}
