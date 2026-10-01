import type { SlackThreadMessage } from "./types.js";

const APPROVE_RE = /\b(approve|approved|approval|lgtm)\b/i;
const REJECT_RE = /\b(reject|rejected|deny|denied)\b/i;
const TICK_RE =
  /(?:\u2705|\u2713|\u2714|\u2611\uFE0F?|☑️|:white_check_mark:|:heavy_check_mark:|:ballot_box_with_check:|:check:|:tick:)/u;

export function isApproveReplyText(text: string): boolean {
  return APPROVE_RE.test(text) || TICK_RE.test(text);
}

export type SlackThreadVerdict =
  | { kind: "approve"; userId: string; text: string }
  | { kind: "reject"; userId: string; text: string }
  | { kind: "none" };

/** First human reply that clearly approves or rejects. Parent and bot messages are ignored. */
export function classifyThreadReplies(messages: SlackThreadMessage[], parentTs: string): SlackThreadVerdict {
  for (const message of messages) {
    if (message.ts === parentTs) continue;
    if (message.botId) continue;
    const userId = message.user?.trim();
    if (!userId) continue;
    const text = message.text.trim();
    if (!text) continue;
    if (REJECT_RE.test(text)) return { kind: "reject", userId, text };
    if (isApproveReplyText(text)) return { kind: "approve", userId, text };
  }
  return { kind: "none" };
}
