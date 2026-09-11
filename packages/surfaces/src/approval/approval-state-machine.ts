import type { PlanningConfirmationMode } from '@invoker/planning-core';
import type { SlackSessionRepository } from '@invoker/data-store';
import type { WorkflowOp, WorkflowOpProgress, WorkflowOpResult } from '../surface.js';
import { isConfirmation, isNegation } from '../slack/plan-conversation.js';
import type { ChatBlocks, ChatTransport, CoreLogFn, SayFn } from './chat-transport.js';

export interface PlanningContext {
  repoUrl?: string;
  presetKey: string;
  workingDir?: string;
  requestedBy?: string;
  lobbyChannel?: string;
  confirmationMode: PlanningConfirmationMode;
  harnessSessionId?: string;
}

export type PendingConfirm =
  | { kind: 'op'; op: WorkflowOp }
  | { kind: 'plan_intent'; requestText: string; userId: string; context: PlanningContext; channel: string; alreadySent?: boolean }
  | { kind: 'restart' };

export type PlanIntentConfirm = Extract<PendingConfirm, { kind: 'plan_intent' }>;

export type PendingConfirmationStore = Pick<
  SlackSessionRepository,
  'createPendingConfirmation' | 'getPendingConfirmation' | 'deletePendingConfirmation'
>;

export type RunWorkflowOpFn = (op: WorkflowOp, onProgress?: (p: WorkflowOpProgress) => void) => Promise<WorkflowOpResult>;

export interface ApprovalStateMachineDeps {
  transport: Pick<ChatTransport, 'update'>;
  blocks: Pick<ChatBlocks, 'confirmPrompt' | 'planIntentPrompt'>;
  log: CoreLogFn;
  allowsControls: (channel: string | undefined) => boolean;
  store?: PendingConfirmationStore;
  runWorkflowOp?: RunWorkflowOpFn;
  restart?: () => Promise<void>;
}

export class ApprovalStateMachine {
  private readonly pendingConfirms = new Map<string, PendingConfirm>();

  constructor(private readonly deps: ApprovalStateMachineDeps) {}

  getPendingConfirm(key: string): PendingConfirm | undefined {
    const inMemory = this.pendingConfirms.get(key);
    if (inMemory) return inMemory;
    const persisted = this.deps.store?.getPendingConfirmation(key);
    if (persisted?.kind !== 'plan_intent' || !persisted.payload || typeof persisted.payload !== 'object') return undefined;
    const pending = persisted.payload as PendingConfirm;
    this.pendingConfirms.set(key, pending);
    return pending;
  }

  stagePendingConfirm(key: string, pending: PendingConfirm): void {
    this.pendingConfirms.set(key, pending);
  }

  clearPendingConfirm(key: string): void {
    this.pendingConfirms.delete(key);
    this.deps.store?.deletePendingConfirmation(key);
  }

  rearmPlanIntentConfirm(key: string, pending: PlanIntentConfirm): void {
    this.pendingConfirms.set(key, pending);
    this.deps.store?.createPendingConfirmation({
      confirmKey: key,
      threadTs: key,
      channelId: pending.channel,
      userId: pending.userId,
      kind: pending.kind,
      payload: pending,
    });
  }

  async stageConfirm(threadTs: string, pending: PendingConfirm, prompt: string, say: SayFn): Promise<void> {
    this.stagePendingConfirm(threadTs, pending);
    await say({
      text: `${prompt}\n_Approve to proceed, or reply \`no\` to cancel._`,
      thread_ts: threadTs,
      blocks: this.deps.blocks.confirmPrompt(prompt, threadTs),
    });
  }

  async stagePlanIntentConfirm(threadTs: string, channel: string, pending: PlanIntentConfirm, say: SayFn): Promise<void> {
    const existing = this.getPendingConfirm(threadTs);
    if (existing) {
      await say({
        text: 'There is already a pending confirmation in this thread. Resolve it before asking again.',
        thread_ts: threadTs,
      });
      return;
    }
    this.pendingConfirms.set(threadTs, pending);
    this.deps.store?.createPendingConfirmation({
      confirmKey: threadTs,
      threadTs,
      channelId: channel,
      userId: pending.userId,
      kind: pending.kind,
      payload: pending,
    });
    this.deps.log('info', `[PLAN_INTENT_CONFIRM] staged key=${threadTs} thread_ts=${threadTs}`);
    await say({
      text: 'Do you want a plan for execution, or should I continue the conversation without planning?',
      thread_ts: threadTs,
      blocks: this.deps.blocks.planIntentPrompt(threadTs),
    });
  }

  async requestOp(op: WorkflowOp, threadTs: string, channel: string, say: SayFn): Promise<void> {
    if (!this.deps.runWorkflowOp) {
      await say({ text: 'Workflow operations are not available in this deployment.', thread_ts: threadTs });
      return;
    }
    if (op.operation !== 'status' && 'all' in op.target) {
      await this.stageConfirm(threadTs, { kind: 'op', op }, `This will \`${op.operation}\` ALL workflows.`, say);
      return;
    }
    await this.runConfirmedOp(op, threadTs, say, channel);
  }

  async requestRestart(threadTs: string, say: SayFn): Promise<void> {
    if (!this.deps.restart) {
      await say({ text: 'Restarting Invoker is not available in this deployment.', thread_ts: threadTs });
      return;
    }
    await this.stageConfirm(threadTs, { kind: 'restart' }, 'This will restart Invoker.', say);
  }

  async rejectNonLobbyControl(threadTs: string, say: SayFn): Promise<void> {
    await say({
      text: 'I can plan here, but restart/submit/workflow controls only work in the lobby channel or DMs.',
      thread_ts: threadTs,
    });
  }

  async resolveConfirm(threadTs: string, text: string, say: SayFn, channel?: string): Promise<boolean> {
    const pending = this.getPendingConfirm(threadTs);
    if (!pending) return false;
    if (!this.deps.allowsControls(channel)) {
      await this.rejectNonLobbyControl(threadTs, say);
      return true;
    }
    if (isConfirmation(text)) {
      this.clearPendingConfirm(threadTs);
      await this.executeConfirm(pending, threadTs, say, channel);
      return true;
    }
    if (isNegation(text)) {
      this.clearPendingConfirm(threadTs);
      await say({ text: 'Cancelled.', thread_ts: threadTs });
      return true;
    }
    this.pendingConfirms.delete(threadTs);
    await say({
      text: 'Dropped the pending approval because the reply was not a confirmation.',
      thread_ts: threadTs,
    });
    return true;
  }

  async executeConfirm(pending: PendingConfirm, threadTs: string, say: SayFn, channel?: string): Promise<void> {
    if (pending.kind === 'op') {
      if (!this.deps.runWorkflowOp) {
        await say({ text: 'Workflow operations are not available in this deployment.', thread_ts: threadTs });
        return;
      }
      await this.runConfirmedOp(pending.op, threadTs, say, channel);
      return;
    }
    await this.runConfirmedRestart(threadTs, say);
  }

  describeOp(op: WorkflowOp): string {
    const target = 'all' in op.target ? 'ALL workflows' : `\`${op.target.workflow}\``;
    return `${op.operation} ${target}`;
  }

  private async runConfirmedOp(op: WorkflowOp, threadTs: string, say: SayFn, channel?: string): Promise<void> {
    const onIt = await say({ text: `On it — ${this.describeOp(op)}. I'll post a summary here when it finishes.`, thread_ts: threadTs });
    const progressTs = onIt?.ts;
    let lastEdit = 0;
    const onProgress = channel && progressTs
      ? (p: WorkflowOpProgress): void => {
          if (p.total <= 1) return;
          const now = Date.now();
          if (now - lastEdit < 2000 && p.done < p.total) return;
          lastEdit = now;
          const icon = p.done >= p.total ? '✅' : '⏳';
          const tail = p.failed ? `, ${p.failed} failed` : '';
          const cur = p.current && p.done < p.total ? ` · now \`${p.current}\`` : '';
          void this.deps.transport
            .update(channel, progressTs, { text: `${icon} ${this.describeOp(op)} — ${p.done}/${p.total} (${p.ok} ok${tail})${cur}` })
            .catch(() => {});
        }
      : undefined;
    try {
      const result = await this.deps.runWorkflowOp!(op, onProgress);
      await say({ text: result.summary, thread_ts: threadTs });
    } catch (err) {
      await say({ text: `Operation failed: ${err instanceof Error ? err.message : String(err)}`, thread_ts: threadTs });
    }
  }

  private async runConfirmedRestart(threadTs: string, say: SayFn): Promise<void> {
    const restart = this.deps.restart;
    if (!restart) {
      await say({ text: 'Restarting Invoker is not available in this deployment.', thread_ts: threadTs });
      return;
    }
    await say({ text: 'Bringing Invoker back… :hourglass_flowing_sand:', thread_ts: threadTs });
    try {
      await restart();
      await say({ text: 'Invoker is back ✅', thread_ts: threadTs });
    } catch (err) {
      await say({ text: `Restart failed: ${err instanceof Error ? err.message : String(err)}`, thread_ts: threadTs });
    }
  }
}
