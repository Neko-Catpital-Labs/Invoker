import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as child_process from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PlanConversation, PlannerAbortedError } from '../slack/plan-conversation.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof child_process>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const mockSpawn = vi.mocked(child_process.spawn);

function createProcess(): any {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

function createCompletedProcess(stdout: string): any {
  const proc = createProcess();
  setTimeout(() => {
    proc.stdout.emit('data', Buffer.from(stdout));
    proc.emit('close', 0);
  }, 0);
  return proc;
}

describe('PlanConversation abortTurn', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sends SIGTERM to the active child and rejects the in-flight turn with PlannerAbortedError', async () => {
    const conversation = new PlanConversation({});
    const proc = createProcess();
    mockSpawn.mockReturnValueOnce(proc);

    const reply = conversation.sendMessage('first message');
    await Promise.resolve();

    expect(conversation.isTurnInFlight()).toBe(true);
    expect(conversation.abortTurn('stop requested')).toBe(true);

    await expect(reply).rejects.toBeInstanceOf(PlannerAbortedError);
    await expect(reply).rejects.toMatchObject({ reason: 'stop requested' });
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(conversation.isTurnInFlight()).toBe(false);
  });

  it('rejects queued turns with PlannerAbortedError without spawning another planner process', async () => {
    const conversation = new PlanConversation({});
    const proc = createProcess();
    mockSpawn.mockReturnValueOnce(proc);

    const firstReply = conversation.sendMessage('first message');
    const secondReply = conversation.sendMessage('second message');
    await Promise.resolve();

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(conversation.abortTurn('stop requested')).toBe(true);

    await expect(firstReply).rejects.toBeInstanceOf(PlannerAbortedError);
    await expect(secondReply).rejects.toBeInstanceOf(PlannerAbortedError);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('allows a new turn to spawn and resolve after an abort', async () => {
    const conversation = new PlanConversation({});
    const firstProc = createProcess();
    mockSpawn.mockReturnValueOnce(firstProc);

    const firstReply = conversation.sendMessage('first message');
    await Promise.resolve();

    expect(conversation.abortTurn('stop requested')).toBe(true);
    await expect(firstReply).rejects.toBeInstanceOf(PlannerAbortedError);

    mockSpawn.mockReturnValueOnce(createCompletedProcess('next reply'));

    await expect(conversation.sendMessage('next message')).resolves.toBe('next reply');
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(conversation.isTurnInFlight()).toBe(false);
  });

  it('returns false and kills nothing when no turn is in flight', () => {
    const conversation = new PlanConversation({});

    expect(conversation.abortTurn('stop requested')).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(conversation.isTurnInFlight()).toBe(false);
  });
});
