import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter, SlackSessionRepository } from '@invoker/data-store';
import { ApprovalStateMachine } from '../approval/approval-state-machine.js';
import type { ApprovalStateMachineDeps, PlanIntentConfirm } from '../approval/approval-state-machine.js';
import type { ChatBlocks, ChatTransport, MessageUpdate, OutboundMessage, SayFn } from '../approval/chat-transport.js';
import type { WorkflowOp, WorkflowOpProgress } from '../surface.js';

vi.mock('@slack/bolt', () => {
  throw new Error('@slack/bolt was loaded by the transport-agnostic approval core');
});

class FakeTransport implements ChatTransport {
  posts: Array<{ channel: string; message: OutboundMessage }> = [];
  updates: Array<{ channel: string; ts: string; message: MessageUpdate }> = [];
  private nextTs = 100;

  async post(channel: string, message: OutboundMessage) {
    this.posts.push({ channel, message });
    return { ts: `${this.nextTs++}.0` };
  }

  async update(channel: string, ts: string, message: MessageUpdate) {
    this.updates.push({ channel, ts, message });
  }

  async react() {}

  async unreact() {}

  sayIn(channel: string): SayFn {
    return (message) => this.post(channel, message);
  }

  texts(): string[] {
    return this.posts.map((p) => p.message.text);
  }
}

const fakeBlocks: ChatBlocks = {
  confirmPrompt: (prompt, key) => [{ fake: 'confirm', prompt, key }],
  planIntentPrompt: (key) => [{ fake: 'plan_intent', key }],
};

describe('approval core over a fake transport', () => {
  let adapter: SQLiteAdapter;
  let sessions: SlackSessionRepository;
  let transport: FakeTransport;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    sessions = new SlackSessionRepository(adapter);
    transport = new FakeTransport();
  });

  afterEach(() => adapter.close());

  function approvals(overrides: Partial<ApprovalStateMachineDeps> = {}): ApprovalStateMachine {
    return new ApprovalStateMachine({
      transport,
      blocks: fakeBlocks,
      log: () => {},
      allowsControls: (channel) => channel === 'LOBBY',
      store: sessions,
      ...overrides,
    });
  }

  it('stages a bulk op, runs it on a yes reply, and edits progress through the port', async () => {
    const runWorkflowOp = vi.fn(async (_op: WorkflowOp, onProgress?: (p: WorkflowOpProgress) => void) => {
      onProgress?.({ done: 2, total: 2, ok: 2, failed: 0 });
      return { summary: 'Retried 2 workflows.' };
    });
    const machine = approvals({ runWorkflowOp });
    const say = transport.sayIn('LOBBY');

    await machine.requestOp({ operation: 'retry', target: { all: true } }, 'T1', 'LOBBY', say);

    expect(runWorkflowOp).not.toHaveBeenCalled();
    expect(transport.posts[0].message).toEqual({
      text: 'This will `retry` ALL workflows.\n_Approve to proceed, or reply `no` to cancel._',
      thread_ts: 'T1',
      blocks: [{ fake: 'confirm', prompt: 'This will `retry` ALL workflows.', key: 'T1' }],
    });
    expect(machine.getPendingConfirm('T1')).toEqual({ kind: 'op', op: { operation: 'retry', target: { all: true } } });

    await expect(machine.resolveConfirm('T1', 'yes', say, 'LOBBY')).resolves.toBe(true);

    expect(runWorkflowOp).toHaveBeenCalledTimes(1);
    expect(transport.texts()).toEqual([
      expect.stringContaining('ALL workflows'),
      "On it — retry ALL workflows. I'll post a summary here when it finishes.",
      'Retried 2 workflows.',
    ]);
    expect(transport.updates).toEqual([
      { channel: 'LOBBY', ts: '101.0', message: { text: '✅ retry ALL workflows — 2/2 (2 ok)' } },
    ]);
    expect(machine.getPendingConfirm('T1')).toBeUndefined();
  });

  it('cancels on a no reply and drops the approval on any other reply', async () => {
    const machine = approvals({ runWorkflowOp: vi.fn() });
    const say = transport.sayIn('LOBBY');

    await machine.requestRestart('T-none', say);
    expect(transport.texts()).toEqual(['Restarting Invoker is not available in this deployment.']);

    await machine.stageConfirm('T-no', { kind: 'restart' }, 'This will restart Invoker.', say);
    await machine.resolveConfirm('T-no', 'no', say, 'LOBBY');
    expect(transport.texts().at(-1)).toBe('Cancelled.');
    expect(machine.getPendingConfirm('T-no')).toBeUndefined();

    await machine.stageConfirm('T-other', { kind: 'restart' }, 'This will restart Invoker.', say);
    await machine.resolveConfirm('T-other', 'maybe later', say, 'LOBBY');
    expect(transport.texts().at(-1)).toBe('Dropped the pending approval because the reply was not a confirmation.');
    expect(machine.getPendingConfirm('T-other')).toBeUndefined();

    await expect(machine.resolveConfirm('T-unknown', 'yes', say, 'LOBBY')).resolves.toBe(false);
  });

  it('refuses to resolve an approval outside the channels the adapter allows', async () => {
    const restart = vi.fn(async () => {});
    const machine = approvals({ restart });
    const say = transport.sayIn('ELSEWHERE');

    await machine.requestRestart('T1', say);
    await machine.resolveConfirm('T1', 'yes', say, 'ELSEWHERE');

    expect(restart).not.toHaveBeenCalled();
    expect(transport.texts().at(-1)).toBe('I can plan here, but restart/submit/workflow controls only work in the lobby channel or DMs.');
    expect(machine.getPendingConfirm('T1')).toEqual({ kind: 'restart' });

    await machine.resolveConfirm('T1', 'yes', say, 'LOBBY');
    expect(restart).toHaveBeenCalledTimes(1);
    expect(transport.texts().slice(-2)).toEqual(['Bringing Invoker back… :hourglass_flowing_sand:', 'Invoker is back ✅']);
  });

  it('persists a plan-intent approval so a fresh state machine recovers it', async () => {
    const pending: PlanIntentConfirm = {
      kind: 'plan_intent',
      requestText: 'add an endpoint',
      userId: 'U1',
      channel: 'LOBBY',
      context: { repoUrl: 'https://github.com/acme/repo.git', presetKey: 'codex', confirmationMode: 'require' },
    };
    const say = transport.sayIn('LOBBY');

    await approvals().stagePlanIntentConfirm('T1', 'LOBBY', pending, say);
    expect(transport.posts[0].message.blocks).toEqual([{ fake: 'plan_intent', key: 'T1' }]);

    const recovered = approvals();
    expect(recovered.getPendingConfirm('T1')).toEqual(pending);

    await recovered.stagePlanIntentConfirm('T1', 'LOBBY', pending, say);
    expect(transport.texts().at(-1)).toBe('There is already a pending confirmation in this thread. Resolve it before asking again.');

    recovered.clearPendingConfirm('T1');
    expect(approvals().getPendingConfirm('T1')).toBeUndefined();
  });
});
