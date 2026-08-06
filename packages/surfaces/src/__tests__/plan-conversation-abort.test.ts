import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as child_process from 'node:child_process';
import { PlanConversation, PlannerAbortedError } from '../slack/plan-conversation.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof child_process>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const mockSpawn = vi.mocked(child_process.spawn);

function createControlledProcess(): any {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

function createMockProcess(stdout: string, exitCode = 0): any {
  const proc = createControlledProcess();
  setTimeout(() => {
    proc.stdout.emit('data', Buffer.from(stdout));
    proc.emit('close', exitCode);
  }, 0);
  return proc;
}

describe('PlanConversation abortTurn', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('SIGTERMs the active child and rejects the in-flight sendMessage with PlannerAbortedError', async () => {
    const conversation = new PlanConversation({});
    const proc = createControlledProcess();
    mockSpawn.mockReturnValueOnce(proc);

    const turn = conversation.sendMessage('first turn');
    await Promise.resolve();

    expect(conversation.isTurnInFlight()).toBe(true);
    expect(conversation.abortTurn('stop requested')).toBe(true);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    await expect(turn).rejects.toMatchObject({
      name: 'PlannerAbortedError',
      reason: 'stop requested',
    });
    expect(conversation.isTurnInFlight()).toBe(false);
  });

  it('rejects queued sendMessage calls with PlannerAbortedError and does not spawn them', async () => {
    const conversation = new PlanConversation({});
    const proc = createControlledProcess();
    mockSpawn.mockReturnValueOnce(proc);

    const firstTurn = conversation.sendMessage('first turn');
    await Promise.resolve();
    const secondTurn = conversation.sendMessage('second turn');

    expect(conversation.abortTurn('stop requested')).toBe(true);

    await expect(firstTurn).rejects.toBeInstanceOf(PlannerAbortedError);
    await expect(secondTurn).rejects.toBeInstanceOf(PlannerAbortedError);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('allows a new sendMessage to spawn and resolve after an abort', async () => {
    const conversation = new PlanConversation({});
    const abortedProc = createControlledProcess();
    mockSpawn
      .mockReturnValueOnce(abortedProc)
      .mockReturnValueOnce(createMockProcess('next reply'));

    const firstTurn = conversation.sendMessage('first turn');
    await Promise.resolve();

    expect(conversation.abortTurn('stop requested')).toBe(true);
    await expect(firstTurn).rejects.toBeInstanceOf(PlannerAbortedError);

    const nextTurn = conversation.sendMessage('after abort');
    await expect(nextTurn).resolves.toBe('next reply');
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('returns false when no turn is in flight and kills nothing', () => {
    const conversation = new PlanConversation({});

    expect(conversation.abortTurn('unused')).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
