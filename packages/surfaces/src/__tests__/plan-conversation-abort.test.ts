import { describe, it, expect, vi, beforeEach } from 'vitest';
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

function createMockProcess(stdout: string, exitCode = 0): any {
  const proc = new EventEmitter() as any;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  proc.stdout = stdoutEmitter;
  proc.stderr = stderrEmitter;
  proc.kill = vi.fn();

  setTimeout(() => {
    stdoutEmitter.emit('data', Buffer.from(stdout));
    proc.emit('close', exitCode);
  }, 0);

  return proc;
}

function createControllableProcess(): any {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn((signal?: string) => {
    if (signal === 'SIGTERM') {
      setTimeout(() => {
        proc.emit('close', null);
      }, 0);
    }
    return true;
  });
  return proc;
}

describe('PlanConversation abortTurn', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('SIGTERMs the active child, rejects the in-flight turn, and drops queued turns without spawning them', async () => {
    const conversation = new PlanConversation({});
    const proc = createControllableProcess();
    mockSpawn.mockReturnValueOnce(proc);

    const inFlight = conversation.sendMessage('first');
    await Promise.resolve();

    const queued = conversation.sendMessage('second');
    await Promise.resolve();

    expect(conversation.isTurnInFlight()).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    expect(conversation.abortTurn('stop requested')).toBe(true);
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    const inFlightError = await inFlight.then(() => null, (error) => error as Error);
    expect(inFlightError).toBeInstanceOf(PlannerAbortedError);
    expect((inFlightError as PlannerAbortedError).reason).toBe('stop requested');

    const queuedError = await queued.then(() => null, (error) => error as Error);
    expect(queuedError).toBeInstanceOf(PlannerAbortedError);
    expect((queuedError as PlannerAbortedError).reason).toBe('stop requested');
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(conversation.isTurnInFlight()).toBe(false);
  });

  it('allows a new turn to spawn and resolve normally after an abort', async () => {
    const conversation = new PlanConversation({});
    const proc = createControllableProcess();
    mockSpawn.mockReturnValueOnce(proc);

    const abortedTurn = conversation.sendMessage('first');
    await Promise.resolve();

    expect(conversation.abortTurn()).toBe(true);
    await expect(abortedTurn).rejects.toBeInstanceOf(PlannerAbortedError);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(conversation.isTurnInFlight()).toBe(false);

    mockSpawn.mockReturnValueOnce(createMockProcess('normal reply'));
    await expect(conversation.sendMessage('second')).resolves.toBe('normal reply');
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('returns false with no turn in flight and does not kill anything', async () => {
    const conversation = new PlanConversation({});
    const proc = createMockProcess('done');
    mockSpawn.mockReturnValueOnce(proc);

    await expect(conversation.sendMessage('hello')).resolves.toBe('done');
    expect(proc.kill).not.toHaveBeenCalled();

    expect(conversation.abortTurn('unused')).toBe(false);
    expect(proc.kill).not.toHaveBeenCalled();
  });
});
