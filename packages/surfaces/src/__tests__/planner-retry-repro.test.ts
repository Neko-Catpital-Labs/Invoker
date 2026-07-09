import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as child_process from 'node:child_process';
import { PlanConversation } from '../slack/plan-conversation.js';

// These tests reproduce the follow-on behavior for the "planner exited 0 with
// no stdout" case that was made fail-visible in the previous slice: instead of
// throwing immediately on the first silent success, `spawnPlanner` should retry
// a bounded number of times with backoff so that transient Cursor/Codex/OMP
// failures (auth token refresh windows, one-off rate-limit blips, network
// hiccups) recover automatically. Each empty-output attempt must still be
// visible in the log so we can observe and reduce the underlying cause over
// time, and non-retryable failures (non-zero exit, spawn error) must NOT be
// retried because those are typically deterministic.

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof child_process>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const mockSpawn = vi.mocked(child_process.spawn);

interface FakeChildOptions {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

// Create the fake child + schedule its emit AT SPAWN TIME, not at test-setup
// time. Between attempts the retry loop backs off, so if we scheduled the
// setTimeout when we built the mock queue, the events would fire before the
// second attempt attached its listeners.
function fakePlannerChildFactory(opts: FakeChildOptions) {
  return () => {
    const { stdout = '', stderr = '', exitCode = 0 } = opts;
    const proc = new EventEmitter() as any;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    proc.stdout = stdoutEmitter;
    proc.stderr = stderrEmitter;
    proc.kill = vi.fn();
    setTimeout(() => {
      if (stdout) stdoutEmitter.emit('data', Buffer.from(stdout));
      if (stderr) stderrEmitter.emit('data', Buffer.from(stderr));
      proc.emit('close', exitCode);
    }, 0);
    return proc;
  };
}

function fakeSpawnErrorChildFactory(message: string) {
  return () => {
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    setTimeout(() => proc.emit('error', new Error(message)), 0);
    return proc;
  };
}

function queueChildFactories(factories: Array<() => any>): void {
  for (const factory of factories) {
    mockSpawn.mockImplementationOnce(factory as any);
  }
}

describe('spawnPlanner retries the empty-output case with logging', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('recovers when a transient empty-stdout attempt is followed by a real reply', async () => {
    const conversation = new PlanConversation({
      plannerRetryLimit: 2,
      plannerRetryBaseDelayMs: 1,
    });
    queueChildFactories([
      fakePlannerChildFactory({ stdout: '', stderr: 'transient blip', exitCode: 0 }),
      fakePlannerChildFactory({ stdout: 'real reply', stderr: '', exitCode: 0 }),
    ]);

    await expect(conversation.sendMessage('Any prompt')).resolves.toBe('real reply');
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(conversation.history).toEqual([
      { role: 'user', content: 'Any prompt' },
      { role: 'assistant', content: 'real reply' },
    ]);
  });

  it('fails with an attempt-count message when every retry attempt is silent', async () => {
    const conversation = new PlanConversation({
      plannerRetryLimit: 2,
      plannerRetryBaseDelayMs: 1,
    });
    queueChildFactories([
      fakePlannerChildFactory({ stdout: '', stderr: 'stderr from attempt 1', exitCode: 0 }),
      fakePlannerChildFactory({ stdout: '', stderr: 'stderr from attempt 2', exitCode: 0 }),
      fakePlannerChildFactory({ stdout: '', stderr: 'stderr from attempt 3', exitCode: 0 }),
    ]);

    const outcome = await conversation.sendMessage('Any prompt').then(
      (reply) => ({ kind: 'resolved' as const, reply }),
      (err: Error) => ({ kind: 'rejected' as const, err }),
    );

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.err.message).toMatch(/3 attempts/);
      expect(outcome.err.message).toContain('stderr from attempt 3');
    }
    expect(mockSpawn).toHaveBeenCalledTimes(3);
  });

  it('logs each empty-output attempt via the [PLANNER_RETRY] channel so the underlying cause is observable', async () => {
    const logSpy = vi.fn();
    const conversation = new PlanConversation({
      plannerRetryLimit: 2,
      plannerRetryBaseDelayMs: 1,
      log: logSpy,
    });
    queueChildFactories([
      fakePlannerChildFactory({ stdout: '', stderr: 'first silent failure', exitCode: 0 }),
      fakePlannerChildFactory({ stdout: 'second attempt reply', stderr: '', exitCode: 0 }),
    ]);

    await conversation.sendMessage('Any prompt');

    const retryLogs = logSpy.mock.calls.filter(([, , msg]: unknown[]) =>
      typeof msg === 'string' && msg.startsWith('[PLANNER_RETRY]'),
    );
    expect(retryLogs.length).toBeGreaterThanOrEqual(1);
    const attemptLog = retryLogs.find(([, , msg]: unknown[]) =>
      typeof msg === 'string' && msg.includes('attempt=1') && msg.includes('first silent failure'),
    );
    expect(attemptLog).toBeDefined();
  });

  it('does not retry when the planner exits with a non-zero status code', async () => {
    const conversation = new PlanConversation({
      plannerRetryLimit: 2,
      plannerRetryBaseDelayMs: 1,
    });
    queueChildFactories([
      fakePlannerChildFactory({ stdout: '', stderr: 'permanent failure', exitCode: 1 }),
    ]);

    await expect(conversation.sendMessage('Any prompt')).rejects.toThrow(/exited with code 1/);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the planner subprocess fails to spawn', async () => {
    const conversation = new PlanConversation({
      plannerRetryLimit: 2,
      plannerRetryBaseDelayMs: 1,
    });
    queueChildFactories([fakeSpawnErrorChildFactory('command not found')]);

    await expect(conversation.sendMessage('Any prompt')).rejects.toThrow(/Failed to spawn/);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('honors plannerRetryLimit=0 for callers that want single-attempt semantics', async () => {
    const conversation = new PlanConversation({
      plannerRetryLimit: 0,
      plannerRetryBaseDelayMs: 1,
    });
    queueChildFactories([
      fakePlannerChildFactory({ stdout: '', stderr: 'silent', exitCode: 0 }),
    ]);

    await expect(conversation.sendMessage('Any prompt')).rejects.toThrow(/no output/);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});
