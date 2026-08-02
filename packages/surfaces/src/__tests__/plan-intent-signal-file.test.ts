import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
