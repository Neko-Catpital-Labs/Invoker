import { createHash, randomUUID } from 'node:crypto';
import type { PersistenceAdapter, SlackPlanDraft } from './adapter.js';

export interface CreateSlackPlanDraft {
  channelId: string;
  threadTs: string;
  planText: string;
  summaryJson: string;
  repoUrl: string;
  harnessPreset: string;
  workingDir: string;
  requestedBy: string;
}

export class SlackPlanDraftRepository {
  constructor(private readonly adapter: PersistenceAdapter) {}

  create(input: CreateSlackPlanDraft): SlackPlanDraft {
    const now = new Date().toISOString();
    const previous = this.adapter.loadReadySlackPlanDraft(input.channelId, input.threadTs);
    const version = (previous?.version ?? 0) + 1;
    this.adapter.supersedeReadySlackPlanDrafts(input.channelId, input.threadTs, now);
    const draft: SlackPlanDraft = {
      draftId: randomUUID(),
      version,
      channelId: input.channelId,
      threadTs: input.threadTs,
      planText: input.planText,
      contentHash: createHash('sha256').update(input.planText).digest('hex'),
      summaryJson: input.summaryJson,
      status: 'preparing',
      repoUrl: input.repoUrl,
      harnessPreset: input.harnessPreset,
      workingDir: input.workingDir,
      requestedBy: input.requestedBy,
      createdAt: now,
    };
    this.adapter.saveSlackPlanDraft(draft);
    return draft;
  }

  get(draftId: string, version: number): SlackPlanDraft | undefined {
    return this.adapter.loadSlackPlanDraft(draftId, version);
  }

  getReady(channelId: string, threadTs: string): SlackPlanDraft | undefined {
    return this.adapter.loadReadySlackPlanDraft(channelId, threadTs);
  }

  bindMessage(draft: SlackPlanDraft, messageTs: string): void {
    this.adapter.updateSlackPlanDraft(draft.draftId, draft.version, { messageTs });
  }

  bindAttachment(draft: SlackPlanDraft, slackFileId: string): void {
    this.adapter.updateSlackPlanDraft(draft.draftId, draft.version, { slackFileId });
  }

  markReady(draft: SlackPlanDraft): void {
    const current = this.get(draft.draftId, draft.version);
    if (!current?.messageTs || !current.slackFileId || current.status !== 'preparing') {
      throw new Error('A Slack plan draft must bind its message and YAML attachment before it is ready.');
    }
    this.adapter.updateSlackPlanDraft(draft.draftId, draft.version, { status: 'ready' });
  }

  claim(draft: SlackPlanDraft): string | undefined {
    const executionKey = `${draft.draftId}:${draft.version}`;
    return this.adapter.claimSlackPlanDraft(draft.draftId, draft.version, executionKey)
      ? executionKey
      : undefined;
  }

  markSubmitted(draft: SlackPlanDraft, workflowIds: string[]): void {
    this.adapter.updateSlackPlanDraft(draft.draftId, draft.version, {
      status: 'submitted',
      workflowIdsJson: JSON.stringify(workflowIds),
    });
  }

  markFailed(draft: SlackPlanDraft, userId: string): void {
    this.adapter.updateSlackPlanDraft(draft.draftId, draft.version, {
      status: 'failed',
      decidedAt: new Date().toISOString(),
      decidedBy: userId,
    });
  }

  decide(
    draft: SlackPlanDraft,
    status: Extract<SlackPlanDraft['status'], 'submitted' | 'rejected'>,
    userId: string,
  ): void {
    this.adapter.updateSlackPlanDraft(draft.draftId, draft.version, {
      status,
      decidedAt: new Date().toISOString(),
      decidedBy: userId,
    });
  }
}
