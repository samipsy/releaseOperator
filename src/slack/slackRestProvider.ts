import { SlackServiceError } from "../errors.js";
import type {
  SlackAuthTestResult,
  SlackPostMessageInput,
  SlackPostMessageResult,
  SlackProvider,
  SlackThreadMessage,
  SlackUser,
} from "./types.js";

const SLACK_API_BASE = "https://slack.com/api";

export interface SlackRestProviderOptions {
  token: string;
  fetchImpl?: typeof fetch;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function stringField(rec: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = rec?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Slack archive permalink: ts 1712345678.123456 → p1712345678123456 */
export function slackMessagePermalink(channel: string, ts: string): string {
  const p = `p${ts.replace(".", "")}`;
  return `https://slack.com/archives/${encodeURIComponent(channel)}/${p}`;
}

export class SlackRestProvider implements SlackProvider {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SlackRestProviderOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async call(method: string, init: { query?: Record<string, string>; body?: Record<string, unknown> }): Promise<Record<string, unknown>> {
    const url = new URL(`${SLACK_API_BASE}/${method}`);
    if (init.query) {
      for (const [key, value] of Object.entries(init.query)) {
        url.searchParams.set(key, value);
      }
    }
    let res: Response;
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
      };
      const request: RequestInit = { method: init.body ? "POST" : "GET", headers };
      if (init.body) {
        headers["Content-Type"] = "application/json";
        request.body = JSON.stringify(init.body);
      }
      res = await this.fetchImpl(url.toString(), request);
    } catch (err) {
      throw new SlackServiceError(`Could not reach Slack API ${method}. (${(err as Error).message})`, err);
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new SlackServiceError(`Slack API ${method} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }
    const rec = asRecord(parsed);
    if (!rec) {
      throw new SlackServiceError(`Slack API ${method} returned an unexpected payload`);
    }
    if (rec.ok !== true) {
      const error = stringField(rec, "error") ?? `HTTP ${res.status}`;
      throw new SlackServiceError(`Slack API ${method} failed: ${error}`);
    }
    return rec;
  }

  async postMessage(input: SlackPostMessageInput): Promise<SlackPostMessageResult> {
    const body: Record<string, unknown> = { channel: input.channel, text: input.text };
    if (input.threadTs) body.thread_ts = input.threadTs;
    const rec = await this.call("chat.postMessage", { body });
    const ts = stringField(rec, "ts");
    const channel = stringField(rec, "channel") ?? input.channel;
    if (!ts) throw new SlackServiceError("Slack chat.postMessage returned no message ts");
    return { ts, channel, url: slackMessagePermalink(channel, ts) };
  }

  async listThreadReplies(input: { channel: string; ts: string }): Promise<SlackThreadMessage[]> {
    const rec = await this.call("conversations.replies", {
      query: { channel: input.channel, ts: input.ts, limit: "200" },
    });
    const raw = rec.messages;
    if (!Array.isArray(raw)) return [];
    const messages: SlackThreadMessage[] = [];
    for (const item of raw) {
      const msg = asRecord(item);
      const ts = stringField(msg, "ts");
      const text = typeof msg?.text === "string" ? msg.text : "";
      if (!ts) continue;
      const user = stringField(msg, "user");
      const botId = stringField(msg, "bot_id");
      messages.push({
        ts,
        text,
        ...(user ? { user } : {}),
        ...(botId ? { botId } : {}),
      });
    }
    return messages;
  }

  async getUser(userId: string): Promise<SlackUser | undefined> {
    const rec = await this.call("users.info", { query: { user: userId } });
    const user = asRecord(rec.user);
    if (!user) return undefined;
    const profile = asRecord(user.profile);
    const name =
      stringField(profile, "display_name") ??
      stringField(profile, "real_name") ??
      stringField(user, "real_name") ??
      stringField(user, "name") ??
      userId;
    const id = stringField(user, "id") ?? userId;
    return { id, name };
  }

  async authTest(): Promise<SlackAuthTestResult> {
    const rec = await this.call("auth.test", { body: {} });
    return {
      team: stringField(rec, "team"),
      user: stringField(rec, "user"),
      userId: stringField(rec, "user_id"),
      url: stringField(rec, "url"),
    };
  }
}
