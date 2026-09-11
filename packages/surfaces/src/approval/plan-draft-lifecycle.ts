import {
  formatPlanSummaryLines,
  preparePlanningReview,
  summarizePlanText,
  type PlanSummary,
  type PlanningConfirmationMode,
} from '@invoker/planning-core';
import type { PlanningDraft, SlackPlanDraftRepository } from '@invoker/data-store';
import type { CommandHandler, SurfaceCommand, SurfaceEvent } from '../surface.js';
import type { PlanningContext } from './approval-state-machine.js';
import type { ChatBlocks, ChatTransport, CoreLogFn, PlanDraftRecord, SayFn } from './chat-transport.js';

export class PlanDraftPostingError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PlanDraftPostingError';
  }
}

export type StageDraftReviewResult =
  | { staged: true }
  | { staged: false; reason: 'not_ready' | 'no_context' }
  | { staged: false; reason: 'posting_error'; message: string; draftId: string };

export type PlanDraftStore = Pick<
  SlackPlanDraftRepository,
  'create' | 'get' | 'bindAttachment' | 'bindMessage' | 'markReady' | 'claim' | 'markSubmitted' | 'markFailed' | 'resolvePlanText' | 'decide'
>;

export interface DraftSource {
  readonly lastTurnDraftPlanText: string | null;
  readonly approvedPlanningDraft: PlanningDraft | null;
  readonly draftDoctorEnabled: boolean;
}

export interface DraftActor {
  channel?: string;
  threadTs?: string;
  userId?: string;
}

export type ReplaceOriginalFn = (text: string) => Promise<void>;

export interface StagePlanDraftInput {
  channelId: string;
  threadTs: string;
  planText: string;
  repoUrl: string;
  harnessPreset: string;
  workingDir: string;
  requestedBy: string;
}

export type AlertEvent = Extract<SurfaceEvent, { type: 'alert' }>;

export interface PlanDraftLifecycleDeps {
  platformName: string;
  transport: Pick<ChatTransport, 'update' | 'upload' | 'awaitUploadVisible' | 'sendWithRetry'>;
  blocks: Pick<ChatBlocks, 'planDraftCard' | 'describeActions'>;
  log: CoreLogFn;
  store?: PlanDraftStore;
  dispatch: (command: SurfaceCommand) => ReturnType<CommandHandler> | undefined;
  normalizePlanRepoUrl: (planText: string, repoUrl: string | undefined) => string;
  loadPlanningContext: (threadTs: string) => PlanningContext | undefined;
  defaultConfirmationMode: PlanningConfirmationMode;
  raiseAlert: (event: AlertEvent) => Promise<void>;
}

type DraftAction = 'approve' | 'cancel' | 'discard';

export class PlanDraftLifecycle {
  constructor(private readonly deps: PlanDraftLifecycleDeps) {}

  async stageDraftReview(
    plannerOutput: string,
    source: DraftSource,
    channel: string,
    threadTs: string,
    userId: string,
    say: SayFn,
    opts: { silentWhenNotReady: boolean },
  ): Promise<StageDraftReviewResult> {
    const store = this.deps.store;
    if (!store) return { staged: false, reason: 'not_ready' };
    const review = preparePlanningReview({
      plannerOutput,
      extractDraftPlanText: () => source.lastTurnDraftPlanText,
      confirmationMode: this.deps.loadPlanningContext(threadTs)?.confirmationMode ?? this.deps.defaultConfirmationMode,
    });
    if ('kind' in review) {
      if (!opts.silentWhenNotReady) {
        await this.deps.transport.sendWithRetry(say, { text: review.reply, thread_ts: threadTs });
      }
      return { staged: false, reason: 'not_ready' };
    }
    const draftReview = review;
    const context = this.deps.loadPlanningContext(threadTs);
    if (!context?.repoUrl || !context.workingDir) {
      if (opts.silentWhenNotReady) {
        this.deps.log('warn', `[DRAFT_STAGE] Skipped staging draft for thread ${threadTs}: no pinned repository context.`);
        return { staged: false, reason: 'no_context' };
      }
      await this.deps.transport.sendWithRetry(say, {
        text: 'This thread has no pinned repository context. Start a new thread with the repository selected.',
        thread_ts: threadTs,
      });
      return { staged: false, reason: 'no_context' };
    }
    const approvedDraft = source.approvedPlanningDraft;
    if (source.draftDoctorEnabled && !approvedDraft) {
      throw new Error('The review text does not exactly match the immutable doctor-approved draft.');
    }
    const planTextForStage = approvedDraft && source.draftDoctorEnabled
      ? approvedDraft.planText
      : this.deps.normalizePlanRepoUrl(
        approvedDraft?.planText ?? draftReview.planText,
        context.repoUrl,
      );
    const planSummary = summarizePlanText(planTextForStage) ?? draftReview.summary;
    const draft = store.create({
      channelId: channel,
      threadTs,
      planningDraftId: approvedDraft?.id,
      planText: planTextForStage,
      summaryJson: JSON.stringify(planSummary),
      repoUrl: context.repoUrl,
      harnessPreset: context.presetKey,
      workingDir: context.workingDir,
      requestedBy: context.requestedBy ?? userId,
      confirmationMode: draftReview.confirmationMode,
    });
    try {
      await this.postPlanDraft(draft, planSummary, say);
      return { staged: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log('error', `Posting plan draft ${draft.draftId}:${draft.version} failed: ${message}`);
      await this.deps.raiseAlert({
        type: 'alert',
        severity: 'critical',
        source: `${this.deps.platformName.toLowerCase()}-plan-draft`,
        subject: draft.draftId,
        message: `Plan review card failed to post: ${message}`,
        alertKey: `plan-draft-post-failed:${draft.draftId}`,
      });
      return { staged: false, reason: 'posting_error', message, draftId: draft.draftId };
    }
  }

  async stagePlanDraftForReview(
    input: StagePlanDraftInput,
    say: SayFn,
  ): Promise<{ draft: PlanDraftRecord; summary: PlanSummary }> {
    const store = this.deps.store;
    if (!store) {
      throw new Error(`${this.deps.platformName} plan reviews are not configured in this deployment.`);
    }
    const planText = this.deps.normalizePlanRepoUrl(input.planText, input.repoUrl);
    const summary = summarizePlanText(planText);
    if (!summary) {
      throw new Error(`The supplied plan YAML could not be summarized for ${this.deps.platformName} review.`);
    }
    const draft = store.create({
      channelId: input.channelId,
      threadTs: input.threadTs,
      planText,
      summaryJson: JSON.stringify(summary),
      repoUrl: input.repoUrl,
      harnessPreset: input.harnessPreset,
      workingDir: input.workingDir,
      requestedBy: input.requestedBy,
      confirmationMode: 'require',
    });
    await this.postPlanDraft(draft, summary, say);
    return { draft: store.get(draft.draftId, draft.version) ?? draft, summary };
  }

  async postPlanDraft(draft: PlanDraftRecord, summary: PlanSummary, say: SayFn): Promise<void> {
    const store = this.deps.store;
    if (!store) return;
    let fileId: string | undefined;
    try {
      fileId = await this.deps.transport.upload({
        channel: draft.channelId,
        threadTs: draft.threadTs,
        content: draft.planText,
        filename: `${draft.draftId}.yaml`,
        title: `${summary.name}.yaml`,
      });
      if (!fileId) throw new Error(`${this.deps.platformName} did not return an uploaded YAML file id.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new PlanDraftPostingError(message, { cause: error });
    }
    store.bindAttachment(draft, fileId);
    await this.deps.transport.awaitUploadVisible?.(draft.channelId, draft.threadTs, fileId);

    const posted = await this.deps.transport.sendWithRetry(say, {
      text: `${summary.name}\n${formatPlanSummaryLines(summary).join('\n')}`,
      thread_ts: draft.threadTs,
      blocks: this.deps.blocks.planDraftCard(summary, draft, 'ready'),
    });
    if (!posted?.ts) throw new PlanDraftPostingError(`${this.deps.platformName} did not return a timestamp for the plan review message.`);
    store.bindMessage(draft, posted.ts);
    store.markReady(draft);
  }

  async submitPlanDraft(draft: PlanDraftRecord, actor: { userId?: string }): Promise<void> {
    const store = this.deps.store;
    if (draft.status !== 'ready') {
      throw new Error(`This plan review is ${draft.status}.`);
    }
    if (!draft.messageTs || !draft.slackFileId) {
      throw new Error('This plan review failed its integrity check and cannot be approved.');
    }
    const approvedPlanText = store?.resolvePlanText(draft);
    if (!approvedPlanText) {
      throw new Error('This plan review has no resolvable immutable draft.');
    }
    const planTextForSubmit = draft.planningDraftId
      ? approvedPlanText
      : this.deps.normalizePlanRepoUrl(approvedPlanText, draft.repoUrl);
    const executionKey = store?.claim(draft);
    if (!executionKey) {
      throw new Error('This plan is already being submitted.');
    }
    await this.replacePlanDraftMessage(draft, 'Starting plan execution…', []);
    try {
      const result = await this.deps.dispatch({
        type: 'start_plan',
        planText: planTextForSubmit,
        repoUrl: draft.repoUrl,
        harnessPreset: draft.harnessPreset,
        requestedBy: draft.requestedBy,
        lobbyChannel: draft.channelId,
        lobbyThreadTs: draft.threadTs,
        executionKey,
      });
      store?.markSubmitted(draft, result?.workflowIds ?? []);
    } catch (error) {
      store?.markFailed(draft, actor.userId ?? 'unknown');
      await this.replacePlanDraftMessage(
        draft,
        `Plan execution failed: ${error instanceof Error ? error.message : String(error)}`,
        [],
      );
      throw error;
    }
  }

  async approvePlanDraft(value: string, actor: DraftActor, replaceOriginal: ReplaceOriginalFn): Promise<void> {
    const draft = await this.resolveActionDraft('approve', value, actor, replaceOriginal);
    if (!draft) return;
    try {
      await this.submitPlanDraft(draft, actor);
    } catch (error) {
      await replaceOriginal(error instanceof Error ? error.message : String(error));
    }
  }

  async cancelPlanDraft(value: string, actor: DraftActor, replaceOriginal: ReplaceOriginalFn): Promise<void> {
    const draft = await this.resolveActionDraft('cancel', value, actor, replaceOriginal);
    if (!draft) return;
    if (draft.status !== 'ready') {
      await replaceOriginal(`This plan review is ${draft.status}.`);
      return;
    }
    const summary = this.parseDraftSummary(draft);
    await this.replacePlanDraftMessage(
      draft,
      `${summary.name}\n${formatPlanSummaryLines(summary).join('\n')}\nPlan not submitted. Draft kept.`,
      this.deps.blocks.planDraftCard(summary, draft, 'kept'),
    );
  }

  async discardPlanDraft(value: string, actor: DraftActor, replaceOriginal: ReplaceOriginalFn): Promise<void> {
    const draft = await this.resolveActionDraft('discard', value, actor, replaceOriginal);
    if (!draft) return;
    if (draft.status !== 'ready') {
      await replaceOriginal(`This plan review is ${draft.status}.`);
      return;
    }
    this.deps.store?.decide(draft, 'rejected', actor.userId ?? 'unknown');
    await this.replacePlanDraftMessage(draft, 'Plan draft discarded.', []);
  }

  private async resolveActionDraft(
    action: DraftAction,
    value: string,
    actor: DraftActor,
    replaceOriginal: ReplaceOriginalFn,
  ): Promise<PlanDraftRecord | undefined> {
    const key = this.parseDraftAction(value);
    const draft = key && this.deps.store?.get(key.draftId, key.version);
    if (!draft || !actor.channel || !actor.threadTs || !actor.userId
      || draft.channelId !== actor.channel || draft.threadTs !== actor.threadTs
      || draft.requestedBy !== actor.userId) {
      this.logDraftActionUnavailable(action, value, key, actor, draft);
      await replaceOriginal('This plan review is no longer available.');
      return undefined;
    }
    return draft;
  }

  private parseDraftAction(value: string): { draftId: string; version: number } | undefined {
    const [draftId, rawVersion] = value.split(':');
    const version = Number(rawVersion);
    return draftId && Number.isInteger(version) && version > 0 ? { draftId, version } : undefined;
  }

  private parseDraftSummary(draft: PlanDraftRecord): PlanSummary {
    return JSON.parse(draft.summaryJson) as PlanSummary;
  }

  private async replacePlanDraftMessage(draft: PlanDraftRecord, text: string, blocks: unknown[]): Promise<void> {
    if (!draft.messageTs) return;
    this.deps.log('info',
      `[OUTBOUND_MESSAGE] chat.update channel=${draft.channelId} thread_ts=${draft.threadTs} ts=${draft.messageTs} draft=${draft.draftId}:${draft.version} textPreview="${text.slice(0, 100).replace(/\n/g, '\\n')}" actions=${this.deps.blocks.describeActions(blocks)}`);
    await this.deps.transport.update(draft.channelId, draft.messageTs, { text, blocks });
  }

  private logDraftActionUnavailable(
    action: DraftAction,
    value: string,
    key: { draftId: string; version: number } | undefined,
    actor: DraftActor,
    draft: PlanDraftRecord | undefined,
  ): void {
    const reasons: string[] = [];
    if (!key) reasons.push('unparseable_button_value');
    if (key && !draft) reasons.push('draft_row_not_found');
    if (!actor.channel) reasons.push('missing_context_channel');
    if (!actor.threadTs) reasons.push('missing_context_threadTs');
    if (!actor.userId) reasons.push('missing_context_userId');
    if (draft && actor.channel && draft.channelId !== actor.channel) reasons.push(`channel_mismatch(draft=${draft.channelId},click=${actor.channel})`);
    if (draft && actor.threadTs && draft.threadTs !== actor.threadTs) reasons.push(`threadTs_mismatch(draft=${draft.threadTs},click=${actor.threadTs})`);
    if (draft && actor.userId && draft.requestedBy !== actor.userId) reasons.push(`requestedBy_mismatch(draft=${draft.requestedBy},click=${actor.userId})`);
    this.deps.log('warn',
      `[PLAN_DRAFT_ACTION_UNAVAILABLE] action=${action} value="${value}" draft=${draft ? `${draft.draftId}:${draft.version}(status=${draft.status})` : 'none'} click_channel=${actor.channel ?? 'none'} click_threadTs=${actor.threadTs ?? 'none'} click_userId=${actor.userId ?? 'none'} reasons=${reasons.join('|') || 'unknown'}`);
  }
}
