import { recordWorkerDecisionRow, type WorkerDecisionStore } from '../worker-decision-ledger.js';
import type { SlackBugScanClient, SlackBugScanMessage } from './slack-bug-scan-client.js';
import { issueFingerprint } from './slack-bug-scan-fingerprint.js';
import { looksLikeBugComplaint } from './slack-bug-scan-prefilter.js';

export const SLACK_BUG_SCAN_WORKER_KIND = 'slack-bug-scan';

export interface SlackBugScanCandidate {
  channelId: string;
  threadTs: string;
  fingerprint: string;
  triggerMessage: SlackBugScanMessage;
  threadMessages: SlackBugScanMessage[];
}

function watermarkKey(channelId: string): string {
  return `channel-watermark:${channelId}`;
}

function convertedKey(channelId: string, threadTs: string, fingerprint: string): string {
  return `converted:${channelId}:${threadTs}:${fingerprint}`;
}

function isHumanMessage(message: SlackBugScanMessage): boolean {
  return !message.botId;
}

export async function scanChannelForCandidates(
  client: SlackBugScanClient,
  store: WorkerDecisionStore,
  channelId: string,
  nowTs: string,
): Promise<SlackBugScanCandidate[]> {
  const watermark = store.getWorkerAction?.(SLACK_BUG_SCAN_WORKER_KIND, watermarkKey(channelId));
  const lastProcessedTs = (watermark?.payload as { lastProcessedTs?: string } | undefined)?.lastProcessedTs;

  if (!lastProcessedTs) {
    recordWorkerDecisionRow(store, {
      workerKind: SLACK_BUG_SCAN_WORKER_KIND,
      actionType: 'channel-watermark',
      externalKey: watermarkKey(channelId),
      subjectType: 'slack-channel',
      subjectId: channelId,
      status: 'completed',
      summary: `Seeded watermark for ${channelId} to now (first sight)`,
      payload: { lastProcessedTs: nowTs },
    });
    return [];
  }

  const newMessages = await client.listHistorySince(channelId, lastProcessedTs);
  const candidates: SlackBugScanCandidate[] = [];

  for (const message of newMessages) {
    if (!isHumanMessage(message)) continue;
    if (!looksLikeBugComplaint(message.text)) continue;

    const threadTs = message.threadTs ?? message.ts;
    const threadMessages = threadTs === message.ts && !message.replyCount
      ? [message]
      : await client.listReplies(channelId, threadTs);

    const fingerprint = issueFingerprint(message.text);
    const existing = store.getWorkerAction?.(
      SLACK_BUG_SCAN_WORKER_KIND,
      convertedKey(channelId, threadTs, fingerprint),
    );
    if (existing) continue;

    candidates.push({ channelId, threadTs, fingerprint, triggerMessage: message, threadMessages });
  }

  recordWorkerDecisionRow(store, {
    workerKind: SLACK_BUG_SCAN_WORKER_KIND,
    actionType: 'channel-watermark',
    externalKey: watermarkKey(channelId),
    subjectType: 'slack-channel',
    subjectId: channelId,
    status: 'completed',
    summary: `Scanned ${channelId}, found ${candidates.length} candidate(s)`,
    payload: { lastProcessedTs: nowTs },
  });

  return candidates;
}

export function recordCandidateOutcome(
  store: WorkerDecisionStore,
  candidate: SlackBugScanCandidate,
  status: 'completed' | 'skipped' | 'failed',
  summary: string,
  extra?: Record<string, unknown>,
): void {
  recordWorkerDecisionRow(store, {
    workerKind: SLACK_BUG_SCAN_WORKER_KIND,
    actionType: 'bug-complaint',
    externalKey: convertedKey(candidate.channelId, candidate.threadTs, candidate.fingerprint),
    subjectType: 'slack-thread',
    subjectId: `${candidate.channelId}:${candidate.threadTs}`,
    status,
    summary,
    payload: extra,
  });
}
