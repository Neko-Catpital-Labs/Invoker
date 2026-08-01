export interface SlackBugScanChannelSummary {
  id: string;
  name?: string;
  topic?: string;
  purpose?: string;
}

export interface SlackBugScanMessage {
  ts: string;
  user?: string;
  botId?: string;
  text: string;
  threadTs?: string;
  replyCount?: number;
}

export interface SlackBugScanClient {
  listMemberChannels(): Promise<SlackBugScanChannelSummary[]>;
  listHistorySince(channelId: string, oldestTs?: string): Promise<SlackBugScanMessage[]>;
  listReplies(channelId: string, threadTs: string): Promise<SlackBugScanMessage[]>;
  postMessage(channelId: string, threadTs: string, text: string): Promise<{ ts: string }>;
}
