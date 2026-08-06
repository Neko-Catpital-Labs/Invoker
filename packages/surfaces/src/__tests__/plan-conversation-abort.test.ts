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

function createControllableProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = 12345;
  proc.kill = vi.fn(() => true);
  return proc;
}

async function settleError<T>(promise: Promise<T>): Promise<unknown> {
  return promise.then(
    () => null,
    (error) => error,
  );
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

    const inFlight = conversation.sendMessage('first turn');
    await Promise.resolve();

    expect(conversation.isTurnInFlight()).toBe(true);
    expect(conversation.abortTurn('stop requested')).toBe(true);
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    const error = await settleError(inFlight);
    expect(error).toBeInstanceOf(PlannerAbortedError);
    expect((error as PlannerAbortedError).reason).toBe('stop requested');
    expect(conversation.isTurnInFlight()).toBe(false);
  });

  it('rejects queued turns with PlannerAbortedError and does not spawn them', async () => {
    const conversation = new PlanConversation({});
    const proc = createControllableProcess();
    mockSpawn.mockReturnValueOnce(proc);

    const firstTurn = conversation.sendMessage('first turn');
    await Promise.resolve();
    const queuedTurn = conversation.sendMessage('second turn');
    await Promise.resolve();

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(conversation.abortTurn('queue cleared')).toBe(true);

    const [firstError, queuedError] = await Promise.all([
      settleError(firstTurn),
      settleError(queuedTurn),
    ]);

    expect(firstError).toBeInstanceOf(PlannerAbortedError);
    expect((firstError as PlannerAbortedError).reason).toBe('queue cleared');
    expect(queuedError).toBeInstanceOf(PlannerAbortedError);
    expect((queuedError as PlannerAbortedError).reason).toBe('queue cleared');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(conversation.isTurnInFlight()).toBe(false);
  });

  it('allows a new turn to spawn and resolve after an abort', async () => {
    const conversation = new PlanConversation({});
    const firstProc = createControllableProcess();
    mockSpawn.mockReturnValueOnce(firstProc);

    const abortedTurn = conversation.sendMessage('first turn');
    await Promise.resolve();

    expect(conversation.abortTurn('retry cleanly')).toBe(true);
    const abortedError = await settleError(abortedTurn);
    expect(abortedError).toBeInstanceOf(PlannerAbortedError);

    const secondProc = createControllableProcess();
    mockSpawn.mockReturnValueOnce(secondProc);

    const recoveredTurn = conversation.sendMessage('second turn');
    await Promise.resolve();

    firstProc.emit('close', 143);
    secondProc.stdout.emit('data', Buffer.from('recovered reply'));
    secondProc.emit('close', 0);

    await expect(recoveredTurn).resolves.toBe('recovered reply');
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(conversation.isTurnInFlight()).toBe(false);
  });

  it('returns false when no turn is in flight', () => {
    const conversation = new PlanConversation({});

    expect(conversation.abortTurn('nothing running')).toBe(false);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
