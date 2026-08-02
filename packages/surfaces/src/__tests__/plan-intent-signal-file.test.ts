import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as child_process from 'node:child_process';
import { PlanConversation } from '../slack/plan-conversation.js';

// An agent-mode turn writes this file to ask for planning permission instead
// of drafting YAML itself. This suite covers the path convention, the
// per-turn reset (a stale signal must never leak into the next turn), and the
// mode gate (plan-mode turns have their own drafting-authorization state
// machine and must never surface this signal).

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof child_process>();
  return { ...actual, spawn: vi.fn() };
});

const mockSpawn = vi.mocked(child_process.spawn);

function fakePlannerChild(stdout: string, beforeClose?: () => void): any {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  setTimeout(() => {
    beforeClose?.();
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    proc.emit('close', 0);
  }, 0);
  return proc;
}

describe('plan intent signal file — path convention', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'plan-intent-'));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  function conversationWith(threadTs: string | undefined): PlanConversation {
    return new PlanConversation({ workingDir, threadTs, mode: 'agent', plannerRetryLimit: 0 });
  }

  it('resolves a plan intent signal path under .invoker when workingDir and threadTs are set', () => {
    const conversation = conversationWith('abc-123');
    expect(conversation.planIntentSignalFilePath()).toBe(
      join(workingDir, '.invoker', 'plan-intent', 'abc-123.json'),
    );
  });

  it('sanitizes threadTs in the plan intent signal path', () => {
    const conversation = conversationWith('abc:123/456');
    expect(conversation.planIntentSignalFilePath()).toBe(
      join(workingDir, '.invoker', 'plan-intent', 'abc_123_456.json'),
    );
  });

  it('has no plan intent signal path without a threadTs', () => {
    expect(conversationWith(undefined).planIntentSignalFilePath()).toBeNull();
  });
});

describe('plan intent signal file — activation side', () => {
  let workingDir: string;

  beforeEach(() => {
    mockSpawn.mockReset();
    workingDir = mkdtempSync(join(tmpdir(), 'plan-intent-act-'));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it('reflects the signal the model wrote this turn', async () => {
    const conversation = new PlanConversation({ workingDir, threadTs: 'abc-123', mode: 'agent', plannerRetryLimit: 0 });
    const path = conversation.planIntentSignalFilePath();
    if (!path) throw new Error('expected a plan intent signal path');

    mockSpawn.mockReturnValueOnce(fakePlannerChild(
      'Sure, want me to draft a plan for this?',
      () => writeFileSync(path, JSON.stringify({ wantsPlan: true }), 'utf8'),
    ));
    await conversation.sendMessage('submit it');

    expect(conversation.lastTurnPlanIntentSignal).toEqual({ wantsPlan: true, reason: undefined });
  });

  it('stays null when the model writes nothing', async () => {
    const conversation = new PlanConversation({ workingDir, threadTs: 'abc-123', mode: 'agent', plannerRetryLimit: 0 });

    mockSpawn.mockReturnValueOnce(fakePlannerChild('Just a normal reply.'));
    await conversation.sendMessage('what does this file do?');

    expect(conversation.lastTurnPlanIntentSignal).toBeNull();
  });

  it('stays null on malformed JSON or a false/missing wantsPlan field', async () => {
    const conversation = new PlanConversation({ workingDir, threadTs: 'abc-123', mode: 'agent', plannerRetryLimit: 0 });
    const path = conversation.planIntentSignalFilePath();
    if (!path) throw new Error('expected a plan intent signal path');

    mockSpawn.mockReturnValueOnce(fakePlannerChild(
      'reply',
      () => writeFileSync(path, '{not valid json', 'utf8'),
    ));
    await conversation.sendMessage('turn 1');
    expect(conversation.lastTurnPlanIntentSignal).toBeNull();

    mockSpawn.mockReturnValueOnce(fakePlannerChild(
      'reply',
      () => writeFileSync(path, JSON.stringify({ wantsPlan: false }), 'utf8'),
    ));
    await conversation.sendMessage('turn 2');
    expect(conversation.lastTurnPlanIntentSignal).toBeNull();
  });

  it('never surfaces the signal in plan mode, even if the model writes it', async () => {
    const conversation = new PlanConversation({ workingDir, threadTs: 'abc-123', mode: 'plan', plannerRetryLimit: 0 });
    const path = conversation.planIntentSignalFilePath();
    if (!path) throw new Error('expected a plan intent signal path');

    mockSpawn.mockReturnValueOnce(fakePlannerChild(
      'reply',
      () => writeFileSync(path, JSON.stringify({ wantsPlan: true }), 'utf8'),
    ));
    await conversation.sendMessage('draft a plan');

    expect(conversation.lastTurnPlanIntentSignal).toBeNull();
  });

  it('resets per turn — a signal from turn 1 never leaks into turn 2', async () => {
    const conversation = new PlanConversation({ workingDir, threadTs: 'abc-123', mode: 'agent', plannerRetryLimit: 0 });
    const path = conversation.planIntentSignalFilePath();
    if (!path) throw new Error('expected a plan intent signal path');

    mockSpawn.mockReturnValueOnce(fakePlannerChild(
      'reply',
      () => writeFileSync(path, JSON.stringify({ wantsPlan: true }), 'utf8'),
    ));
    await conversation.sendMessage('submit it');
    expect(conversation.lastTurnPlanIntentSignal).toEqual({ wantsPlan: true, reason: undefined });

    mockSpawn.mockReturnValueOnce(fakePlannerChild('a normal follow-up, no file written'));
    await conversation.sendMessage('what did you just do?');
    expect(conversation.lastTurnPlanIntentSignal).toBeNull();
  });
});

describe('plan intent signal file — concurrent turns are serialized', () => {
  let workingDir: string;

  beforeEach(() => {
    mockSpawn.mockReset();
    workingDir = mkdtempSync(join(tmpdir(), 'plan-intent-race-'));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  // A manually-controlled child: unlike fakePlannerChild, nothing closes it
  // automatically. The test decides exactly when each turn's model "finishes
  // writing its file" and "exits", to construct a specific interleaving
  // deterministically rather than relying on timer race luck.
  function controlledChild(): { proc: any; close: (stdout: string) => void } {
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    return {
      proc,
      close: (stdout: string) => {
        proc.stdout.emit('data', Buffer.from(stdout));
        proc.emit('close', 0);
      },
    };
  }

  // How many internal awaits sit between calling sendMessage and spawn()
  // actually being invoked is an implementation detail (init(), retry setup,
  // etc). Rather than hand-count microtask ticks, flush them until the
  // condition we actually care about is true.
  async function flushUntil(predicate: () => boolean, maxTicks = 50): Promise<void> {
    for (let i = 0; i < maxTicks; i++) {
      if (predicate()) return;
      await Promise.resolve();
    }
    throw new Error('condition never became true within maxTicks microtask flushes');
  }

  it('does not let a second concurrent turn wipe a signal before the first turn reads it back', async () => {
    const conversation = new PlanConversation({ workingDir, threadTs: 'race-thread', mode: 'agent', plannerRetryLimit: 0 });
    const path = conversation.planIntentSignalFilePath();
    if (!path) throw new Error('expected a plan intent signal path');
    mkdirSync(join(workingDir, '.invoker', 'plan-intent'), { recursive: true });

    const a = controlledChild();
    const b = controlledChild();
    mockSpawn.mockImplementationOnce(() => a.proc);
    mockSpawn.mockImplementationOnce(() => b.proc);

    let signalWhenAResolved: unknown;
    let signalWhenBResolved: unknown;
    const sendA = conversation.sendMessage('submit it').then((reply) => {
      signalWhenAResolved = conversation.lastTurnPlanIntentSignal;
      return reply;
    });
    await flushUntil(() => mockSpawn.mock.calls.length >= 1); // let A reach spawn(A)

    // A's model "writes its file" mid-turn (process is still open).
    writeFileSync(path, JSON.stringify({ wantsPlan: true }), 'utf8');

    // Before A's process has exited, a second turn is requested on the same
    // conversation (e.g. two Slack events for this thread arriving close
    // together). With serialization, B's own turn-setup reset is deferred
    // until A fully finishes — it cannot race A's not-yet-executed read.
    const sendB = conversation.sendMessage('what does this mean?').then((reply) => {
      signalWhenBResolved = conversation.lastTurnPlanIntentSignal;
      return reply;
    });

    a.close('sure, want me to draft one for that?');
    await sendA;

    await flushUntil(() => mockSpawn.mock.calls.length >= 2); // let B reach spawn(B)
    b.close('just a normal reply, no file written');
    await sendB;

    // A must see its own signal — not have it wiped by B's concurrent turn.
    expect(signalWhenAResolved).toEqual({ wantsPlan: true, reason: undefined });
    // B's own turn wrote nothing, so once B's (serialized, later) turn runs
    // its own reset+read, it correctly sees nothing.
    expect(signalWhenBResolved).toBeNull();
  });

  it('processes 3 concurrent calls in strict FIFO (call) order, not close order', async () => {
    const conversation = new PlanConversation({ workingDir, threadTs: 'race-thread-3', mode: 'agent', plannerRetryLimit: 0 });

    const a = controlledChild();
    const b = controlledChild();
    const c = controlledChild();
    mockSpawn.mockImplementationOnce(() => a.proc);
    mockSpawn.mockImplementationOnce(() => b.proc);
    mockSpawn.mockImplementationOnce(() => c.proc);

    const resolutionOrder: string[] = [];
    const sendA = conversation.sendMessage('A').then((r) => { resolutionOrder.push('A'); return r; });
    await flushUntil(() => mockSpawn.mock.calls.length >= 1);

    // B and C both queue behind A, in call order, before A has finished.
    const sendB = conversation.sendMessage('B').then((r) => { resolutionOrder.push('B'); return r; });
    const sendC = conversation.sendMessage('C').then((r) => { resolutionOrder.push('C'); return r; });

    // Give the event loop plenty of chances to let B/C's own turn-setup run
    // if it were going to happen concurrently with A. With serialization,
    // neither can reach spawn() until A finishes, no matter how many ticks
    // pass — this is the direct, unambiguous proof (not just resolution
    // order, which close-timing games alone don't reliably discriminate).
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(mockSpawn.mock.calls.length).toBe(1);

    a.close('a reply');
    await sendA;
    await flushUntil(() => mockSpawn.mock.calls.length >= 2);

    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(mockSpawn.mock.calls.length).toBe(2); // B started, C still queued behind it

    b.close('b reply');
    await sendB;
    await flushUntil(() => mockSpawn.mock.calls.length >= 3);
    c.close('c reply');
    await sendC;

    // Regardless of any close-timing games, the queue releases in the order
    // calls arrived — never something else.
    expect(resolutionOrder).toEqual(['A', 'B', 'C']);
  });

  it('does not corrupt the queue when a queued turn fails — the next turn still runs', async () => {
    const conversation = new PlanConversation({ workingDir, threadTs: 'race-thread-fail', mode: 'agent', plannerRetryLimit: 0 });

    const a = controlledChild();
    const b = controlledChild();
    mockSpawn.mockImplementationOnce(() => a.proc);
    mockSpawn.mockImplementationOnce(() => b.proc);

    const sendA = conversation.sendMessage('A');
    await flushUntil(() => mockSpawn.mock.calls.length >= 1);

    // B queues behind A before A fails.
    const sendB = conversation.sendMessage('B');

    // While A is still in flight, B must not have reached spawn() yet — the
    // lock has to hold even though A is about to fail, not just when A
    // succeeds. (Without this check, A and B would just run independently
    // and this test would pass whether or not the lock exists at all.)
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(mockSpawn.mock.calls.length).toBe(1);

    // A fails: non-zero exit.
    a.proc.stderr.emit('data', Buffer.from('boom'));
    a.proc.emit('close', 1);
    await expect(sendA).rejects.toThrow();

    // The lock must still release on failure (via .finally()) — B runs next,
    // not stuck behind a permanently-held lock.
    await flushUntil(() => mockSpawn.mock.calls.length >= 2);
    b.close('b reply, after a failed');
    await expect(sendB).resolves.toBe('b reply, after a failed');
  });

  it('does not block a different conversation instance (the lock is per-instance, not shared)', async () => {
    const conversationX = new PlanConversation({ workingDir, threadTs: 'thread-x', mode: 'agent', plannerRetryLimit: 0 });
    const conversationY = new PlanConversation({ workingDir, threadTs: 'thread-y', mode: 'agent', plannerRetryLimit: 0 });

    const x = controlledChild();
    const y = controlledChild();
    mockSpawn.mockImplementationOnce(() => x.proc);
    mockSpawn.mockImplementationOnce(() => y.proc);

    // X starts and does NOT finish (its process stays open).
    const sendX = conversationX.sendMessage('for X');
    await flushUntil(() => mockSpawn.mock.calls.length >= 1);

    // Y, on a DIFFERENT conversation instance, must still reach spawn()
    // immediately — it must not wait behind X's still-open turn.
    const sendY = conversationY.sendMessage('for Y');
    await flushUntil(() => mockSpawn.mock.calls.length >= 2);

    y.close('y reply');
    await expect(sendY).resolves.toBe('y reply');

    x.close('x reply');
    await expect(sendX).resolves.toBe('x reply');
  });
});
