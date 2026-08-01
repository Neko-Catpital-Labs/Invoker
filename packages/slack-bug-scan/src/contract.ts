export const SLACK_BUG_SCAN_WORKER_KIND = 'slack-bug-scan';

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

export interface SlackBugScanClassifyResult {
  isBugComplaint: boolean;
  problemStatement?: string;
}

export type SlackBugScanClassifier = (input: {
  channelId: string;
  threadTs: string;
  repoUrl: string;
  threadText: string;
}) => Promise<SlackBugScanClassifyResult>;

export interface SlackBugScanDraftResult {
  planName: string;
  workflowId: string;
}

export type SlackBugScanPlanSubmitter = (input: {
  channelId: string;
  threadTs: string;
  repoUrl: string;
  problemStatement: string;
  threadText: string;
}) => Promise<SlackBugScanDraftResult>;
