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
    vi.clearAllMocks();
  });

  it('SIGTERMs the active child and rejects the in-flight turn with PlannerAbortedError', async () => {
    const conversation = new PlanConversation({});
    const proc = createControlledProcess();
    mockSpawn.mockReturnValueOnce(proc);

    const reply = conversation.sendMessage('First');
    await Promise.resolve();

    expect(conversation.isTurnInFlight()).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(conversation.abortTurn('stop requested')).toBe(true);

    const error = await reply.then(() => null, (err) => err as Error);
    expect(error).toBeInstanceOf(PlannerAbortedError);
    expect(error).toMatchObject({ reason: 'stop requested' });
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(conversation.isTurnInFlight()).toBe(false);
  });

  it('rejects queued turns with PlannerAbortedError without spawning again', async () => {
    const conversation = new PlanConversation({});
    const proc = createControlledProcess();
    mockSpawn.mockReturnValueOnce(proc);

    const first = conversation.sendMessage('First');
    const second = conversation.sendMessage('Second');
    await Promise.resolve();

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(conversation.abortTurn('queue cleared')).toBe(true);

    const firstError = await first.then(() => null, (err) => err as Error);
    const secondError = await second.then(() => null, (err) => err as Error);
    expect(firstError).toBeInstanceOf(PlannerAbortedError);
    expect(secondError).toBeInstanceOf(PlannerAbortedError);
    expect(secondError).toMatchObject({ reason: 'queue cleared' });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('allows a new turn to spawn and resolve normally after an abort', async () => {
    const conversation = new PlanConversation({});
    const firstProc = createControlledProcess();
    mockSpawn
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(createMockProcess('Recovered.'));

    const aborted = conversation.sendMessage('First');
    await Promise.resolve();
    expect(conversation.abortTurn('restart')).toBe(true);
    await expect(aborted).rejects.toBeInstanceOf(PlannerAbortedError);

    const reply = await conversation.sendMessage('Second');

    expect(reply).toBe('Recovered.');
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(conversation.isTurnInFlight()).toBe(false);
  });

  it('returns false when no turn is in flight', () => {
    const conversation = new PlanConversation({});

    expect(conversation.abortTurn('unused')).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(conversation.isTurnInFlight()).toBe(false);
  });
});
