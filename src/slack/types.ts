export interface SlackPostMessageInput {
  channel: string;
  text: string;
  threadTs?: string;
}

export interface SlackPostMessageResult {
  ts: string;
  channel: string;
  url?: string;
}

export interface SlackThreadMessage {
  ts: string;
  text: string;
  user?: string;
  botId?: string;
}

export interface SlackUser {
  id: string;
  name: string;
}

export interface SlackAuthTestResult {
  team?: string;
  user?: string;
  userId?: string;
  url?: string;
}

export interface SlackProvider {
  postMessage(input: SlackPostMessageInput): Promise<SlackPostMessageResult>;
  listThreadReplies(input: { channel: string; ts: string }): Promise<SlackThreadMessage[]>;
  getUser(userId: string): Promise<SlackUser | undefined>;
  authTest(): Promise<SlackAuthTestResult>;
}
