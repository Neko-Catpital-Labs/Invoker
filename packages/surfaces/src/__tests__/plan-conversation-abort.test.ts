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

function createControllableProcess(): any {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

function createResolvedProcess(stdout: string): any {
  const proc = createControllableProcess();
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

  it('SIGTERMs the active child and rejects the in-flight turn with PlannerAbortedError', async () => {
    const conversation = new PlanConversation({});
    const proc = createControllableProcess();
    mockSpawn.mockReturnValueOnce(proc);

    const inFlight = conversation.sendMessage('first');
    await Promise.resolve();

    expect(conversation.isTurnInFlight()).toBe(true);
    expect(conversation.abortTurn('stop')).toBe(true);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    await expect(inFlight).rejects.toBeInstanceOf(PlannerAbortedError);
    await expect(inFlight).rejects.toMatchObject({ reason: 'stop' });
    expect(conversation.isTurnInFlight()).toBe(false);
  });

  it('rejects queued turns with PlannerAbortedError without spawning again', async () => {
    const conversation = new PlanConversation({});
    const proc = createControllableProcess();
    mockSpawn.mockReturnValueOnce(proc);

    const first = conversation.sendMessage('first');
    const second = conversation.sendMessage('second');
    await Promise.resolve();

    expect(conversation.abortTurn('stop')).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    await expect(first).rejects.toBeInstanceOf(PlannerAbortedError);
    await expect(second).rejects.toBeInstanceOf(PlannerAbortedError);
  });

  it('allows a new turn to spawn and resolve normally after an abort', async () => {
    const conversation = new PlanConversation({});
    const abortedProc = createControllableProcess();
    mockSpawn.mockReturnValueOnce(abortedProc);

    const first = conversation.sendMessage('first');
    await Promise.resolve();

    expect(conversation.abortTurn('stop')).toBe(true);
    await expect(first).rejects.toBeInstanceOf(PlannerAbortedError);

    mockSpawn.mockReturnValueOnce(createResolvedProcess('next reply'));
    await expect(conversation.sendMessage('after abort')).resolves.toBe('next reply');
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('returns false and does not kill anything when no turn is in flight', () => {
    const conversation = new PlanConversation({});

    expect(conversation.abortTurn('stop')).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(conversation.isTurnInFlight()).toBe(false);
  });
});
