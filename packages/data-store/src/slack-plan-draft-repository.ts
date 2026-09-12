import { createHash, randomUUID } from 'node:crypto';
import type { PersistenceAdapter, SlackPlanDraft } from './adapter.js';
import { PlanningDraftRepository } from './planning-draft-repository.js';

export interface CreateSlackPlanDraft {
  channelId: string;
  threadTs: string;
  planningDraftId?: string;
  planText: string;
  summaryJson: string;
  repoUrl: string;
  harnessPreset: string;
  workingDir: string;
  requestedBy: string;
  confirmationMode: SlackPlanDraft['confirmationMode'];
}

export class SlackPlanDraftRepository {
  private readonly planningDrafts: PlanningDraftRepository;

  constructor(private readonly adapter: PersistenceAdapter) {
    this.planningDrafts = new PlanningDraftRepository(adapter);
  }

  create(input: CreateSlackPlanDraft): SlackPlanDraft {
    const now = new Date().toISOString();
    if (input.planningDraftId) {
      const approved = this.planningDrafts.get(input.planningDraftId);
      const inputHash = createHash('sha256').update(input.planText).digest('hex');
      if (!approved
        || approved.conversationId !== input.threadTs
        || approved.status !== 'current'
        || approved.contentHash !== inputHash
        || approved.planText !== input.planText) {
        throw new Error('Slack review must reference the exact current doctor-approved planning draft.');
      }
    }
    const previous = this.adapter.loadReadySlackPlanDraft(input.channelId, input.threadTs);
    const version = (previous?.version ?? 0) + 1;
    this.adapter.supersedeReadySlackPlanDrafts(input.channelId, input.threadTs, now);
    const draft: SlackPlanDraft = {
      draftId: randomUUID(),
      version,
      planningDraftId: input.planningDraftId,
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
      confirmationMode: input.confirmationMode,
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
    if (draft.planningDraftId) {
      this.planningDrafts.markSubmitted(draft.planningDraftId);
    }
  }

  resolvePlanText(draft: SlackPlanDraft): string {
    if (!draft.planningDraftId) {
      const legacyHash = createHash('sha256').update(draft.planText).digest('hex');
      if (legacyHash !== draft.contentHash) {
        throw new Error('This legacy plan review failed its integrity check.');
      }
      return draft.planText;
    }
    const approved = this.planningDrafts.get(draft.planningDraftId);
    if (!approved
      || approved.conversationId !== draft.threadTs
      || approved.planText !== draft.planText
      || approved.contentHash !== draft.contentHash) {
      throw new Error('This plan review no longer matches its immutable approved draft.');
    }
    return approved.planText;
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
    if (status === 'rejected' && draft.planningDraftId) {
      this.planningDrafts.supersede(draft.planningDraftId);
    }
  }
}
