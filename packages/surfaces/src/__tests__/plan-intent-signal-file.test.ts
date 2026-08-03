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
});
