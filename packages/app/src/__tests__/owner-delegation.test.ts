import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { delegationTimeoutMs, tryDelegateExec, tryDelegateRun, tryDelegateResume } from '../headless.js';
import { LocalBus } from '@invoker/transport';
import type { MessageBus, RequestHandler, RequestOptions, Unsubscribe } from '@invoker/transport';
import type { HeadlessTargetLookup } from '../headless-command-classification.js';

/**
 * Regression tests for headless→owner RPC delegation.
 *
 * These tests verify that when a headless process (non-owner) attempts a mutation
 * and an owner process is available, the command is successfully delegated via
 * MessageBus RPC and executed by the owner.
 */
describe('headless→owner delegation', () => {
  let messageBus: MessageBus;
  let targetLookup: HeadlessTargetLookup;

  beforeEach(() => {
    messageBus = new LocalBus();
    targetLookup = {
      loadWorkflow: (workflowId) => (
        workflowId === 'wf-1' || workflowId === 'wf-123'
          ? { id: workflowId } as any
          : undefined
      ),
      listWorkflows: () => [{ id: 'wf-1' } as any, { id: 'wf-123' } as any],
      loadTasks: (workflowId) => {
        if (workflowId === 'wf-1') {
          return [{ id: '__merge__wf-1' }] as any;
        }
        if (workflowId === 'wf-123') {
          return [{ id: 'wf-123/task-1' }] as any;
        }
        return [];
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function trackPromise<T>(promise: Promise<T>) {
    const state: {
      settled: boolean;
      value?: T;
      error?: unknown;
    } = { settled: false };

    promise.then(
      (value) => {
        state.settled = true;
        state.value = value;
      },
      (error) => {
        state.settled = true;
        state.error = error;
      },
    );

    return state;
  }

  describe('delegation timeout policy', () => {
    it('uses 60s timeout for workflow-scoped rebase-retry', () => {
      expect(delegationTimeoutMs(['rebase-retry', 'wf-1'], targetLookup)).toBe(60_000);
    });

    it('uses 60s timeout for workflow-scoped rebase-recreate', () => {
      expect(delegationTimeoutMs(['rebase-recreate', 'wf-1'], targetLookup)).toBe(60_000);
    });

    it('uses 60s timeout for workflow-scoped restart', () => {
      expect(delegationTimeoutMs(['restart', 'wf-123'], targetLookup)).toBe(60_000);
    });

    it('uses 60s timeout for task-scoped recreate-task', () => {
      expect(delegationTimeoutMs(['recreate-task', 'wf-123/task-1'], targetLookup)).toBe(60_000);
    });

    it('keeps task-scoped rebase-retry at the default timeout', () => {
      expect(delegationTimeoutMs(['rebase-retry', 'wf-123/task-1'], targetLookup)).toBe(5_000);
    });

    it('keeps non-matching workflow ids at the default timeout', () => {
      expect(delegationTimeoutMs(['restart', 'not-a-workflow-id'], targetLookup)).toBe(5_000);
    });

    it('keeps unrelated commands at the default timeout', () => {
      expect(delegationTimeoutMs(['approve', 'wf-123/task-1'], targetLookup)).toBe(5_000);
    });

    it('passes extended recreate-task timeout through to the message bus request', async () => {
      const request = vi.fn(async () => ({ ok: true }));
      const bus: MessageBus = {
        subscribe: vi.fn(() => undefined as unknown as Unsubscribe),
        publish: vi.fn(),
        request,
        onRequest: vi.fn((_channel: string, _handler: RequestHandler) => undefined as unknown as Unsubscribe),
        disconnect: vi.fn(),
      };

      const outcome = await tryDelegateExec(['recreate-task', 'wf-123/task-1'], bus);

      expect(outcome.kind).toBe('delegated');
      expect(request).toHaveBeenCalledWith(
        'headless.exec',
        expect.objectContaining({ args: ['recreate-task', 'wf-123/task-1'] }),
        { timeoutMs: 60_000 } satisfies RequestOptions,
      );
    });
  });

  describe('successful delegation when owner is present', () => {
    it('delegates mutation command to owner via RPC', async () => {
      // Simulate owner process registering a handler
      const ownerHandler = vi.fn(async (_req: { args: string[] }) => {
        // Owner successfully executed the command
        return { ok: true };
      });

      messageBus.onRequest('headless.exec', ownerHandler);

      // Headless process attempts to delegate
      const outcome = await tryDelegateExec(['run', '/path/to/plan.yaml'], messageBus);

      // Verify delegation succeeded
      expect(outcome.kind).toBe('delegated');
      expect(ownerHandler).toHaveBeenCalledWith(expect.objectContaining({
        args: ['run', '/path/to/plan.yaml'],
        noTrack: undefined,
        waitForApproval: undefined,
      }));
    });

    it('delegates with waitForApproval flag', async () => {
      const ownerHandler = vi.fn(async () => ({ ok: true }));
      messageBus.onRequest('headless.exec', ownerHandler);

      await tryDelegateExec(['approve', 'task-1'], messageBus, true);

      expect(ownerHandler).toHaveBeenCalledWith(expect.objectContaining({
        args: ['approve', 'task-1'],
        waitForApproval: true,
      }));
    });

    it('delegates retry-task command to owner', async () => {
      const ownerHandler = vi.fn(async () => ({ ok: true }));
      messageBus.onRequest('headless.exec', ownerHandler);

      const outcome = await tryDelegateExec(['retry-task', 'wf-1/task-1'], messageBus);

      expect(outcome.kind).toBe('delegated');
      expect(ownerHandler).toHaveBeenCalledWith(expect.objectContaining({
        args: ['retry-task', 'wf-1/task-1'],
        waitForApproval: undefined,
      }));
    });

    it('delegates resume command to owner', async () => {
      const ownerHandler = vi.fn(async () => ({ ok: true }));
      messageBus.onRequest('headless.exec', ownerHandler);

      const outcome = await tryDelegateExec(['resume', 'wf-1'], messageBus);

      expect(outcome.kind).toBe('delegated');
      expect(ownerHandler).toHaveBeenCalledWith(expect.objectContaining({
        args: ['resume', 'wf-1'],
        waitForApproval: undefined,
      }));
    });

    it('delegates approve command to owner', async () => {
      const ownerHandler = vi.fn(async () => ({ ok: true }));
      messageBus.onRequest('headless.exec', ownerHandler);

      const outcome = await tryDelegateExec(['approve', 'wf-1/task-1'], messageBus);

      expect(outcome.kind).toBe('delegated');
      expect(ownerHandler).toHaveBeenCalledWith(expect.objectContaining({
        args: ['approve', 'wf-1/task-1'],
        waitForApproval: undefined,
      }));
    });

    it('delegates reject command to owner', async () => {
      const ownerHandler = vi.fn(async () => ({ ok: true }));
      messageBus.onRequest('headless.exec', ownerHandler);

      const outcome = await tryDelegateExec(['reject', 'wf-1/task-1', 'reason text'], messageBus);

      expect(outcome.kind).toBe('delegated');
      expect(ownerHandler).toHaveBeenCalledWith(expect.objectContaining({
        args: ['reject', 'wf-1/task-1', 'reason text'],
        waitForApproval: undefined,
      }));
    });

    it('delegates set command to owner', async () => {
      const ownerHandler = vi.fn(async () => ({ ok: true }));
      messageBus.onRequest('headless.exec', ownerHandler);

      const outcome = await tryDelegateExec(
        ['set', 'command', 'wf-1/task-1', 'new command'],
        messageBus,
      );

      expect(outcome.kind).toBe('delegated');
      expect(ownerHandler).toHaveBeenCalledWith(expect.objectContaining({
        args: ['set', 'command', 'wf-1/task-1', 'new command'],
        waitForApproval: undefined,
      }));
    });

    it('delegates set prompt to owner (prompt-edit bridge)', async () => {
      const ownerHandler = vi.fn(async () => ({ ok: true }));
      messageBus.onRequest('headless.exec', ownerHandler);

      const outcome = await tryDelegateExec(
        ['set', 'prompt', 'wf-1/task-1', 'updated prompt text'],
        messageBus,
      );

      expect(outcome.kind).toBe('delegated');
      expect(ownerHandler).toHaveBeenCalledWith(expect.objectContaining({
        args: ['set', 'prompt', 'wf-1/task-1', 'updated prompt text'],
        waitForApproval: undefined,
      }));
    });

    it('delegates rebase-retry with noTrack so owner can return before workflow settlement', async () => {
      const ownerHandler = vi.fn(async () => ({ ok: true }));
      messageBus.onRequest('headless.exec', ownerHandler);

      const outcome = await tryDelegateExec(
        ['rebase-retry', 'wf-1/task-1'],
        messageBus,
        undefined,
        true,
      );

      expect(outcome.kind).toBe('delegated');
      expect(ownerHandler).toHaveBeenCalledWith(expect.objectContaining({
        args: ['rebase-retry', 'wf-1/task-1'],
        noTrack: true,
        waitForApproval: undefined,
      }));
    });

    it('delegates rebase-recreate command to owner', async () => {
      const ownerHandler = vi.fn(async () => ({ ok: true }));
      messageBus.onRequest('headless.exec', ownerHandler);

      const outcome = await tryDelegateExec(
        ['rebase-recreate', 'wf-1'],
        messageBus,
        undefined,
        true,
      );

      expect(outcome.kind).toBe('delegated');
      expect(ownerHandler).toHaveBeenCalledWith(expect.objectContaining({
        args: ['rebase-recreate', 'wf-1'],
        noTrack: true,
        waitForApproval: undefined,
      }));
    });
  });

  describe('fallback to standalone when owner is unavailable', () => {
    it('returns no-handler outcome when no owner handler is registered', async () => {
      // No handler registered — no owner present
      const outcome = await tryDelegateExec(['run', '/path/to/plan.yaml'], messageBus);

      // Should fall back to standalone mode
      expect(outcome.kind).toBe('no-handler');
    });

    it('returns timeout outcome when delegation times out (owner unresponsive)', async () => {
      vi.useFakeTimers();
      messageBus.onRequest('headless.exec', async () => new Promise(() => {}));

      const delegatedPromise = tryDelegateExec(['approve', 'wf-1/task-1'], messageBus);
      const tracked = trackPromise(delegatedPromise);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(tracked.settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const outcome = await delegatedPromise;
      expect(outcome.kind).toBe('timeout');
    });
  });

  describe('tryDelegateExec applies command-aware timeout selection deterministically', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      messageBus.onRequest('headless.exec', async () => new Promise(() => {}));
    });

    it.each([
      ['rebase-retry', ['rebase-retry', 'wf-1']],
      ['rebase-recreate', ['rebase-recreate', 'wf-1']],
      ['restart workflow', ['restart', 'wf-123']],
    ])('keeps %s pending at 5s and only times out at 60s', async (_label, args) => {
      const delegatedPromise = tryDelegateExec(
        args,
        messageBus,
        undefined,
        undefined,
        delegationTimeoutMs(args, targetLookup),
      );
      const tracked = trackPromise(delegatedPromise);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(tracked.settled).toBe(false);

      await vi.advanceTimersByTimeAsync(54_999);
      expect(tracked.settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const outcome = await delegatedPromise;
      expect(outcome.kind).toBe('timeout');
    });

    it.each([
      ['restart task', ['restart', 'wf-123/task-1']],
      ['approve', ['approve', 'wf-123/task-1']],
    ])('times out at the default 5s for %s', async (_label, args) => {
      const delegatedPromise = tryDelegateExec(
        args,
        messageBus,
        undefined,
        undefined,
        delegationTimeoutMs(args, targetLookup),
      );
      const tracked = trackPromise(delegatedPromise);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(tracked.settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const outcome = await delegatedPromise;
      expect(outcome.kind).toBe('timeout');
    });
  });

  describe('error propagation from owner', () => {
    it('propagates errors from owner process', async () => {
      // Owner handler throws an error
      messageBus.onRequest('headless.exec', async () => {
        throw new Error('Owner execution failed: task not found');
      });

      // Error should propagate to caller (not caught as "no owner")
      await expect(
        tryDelegateExec(['retry-task', 'wf-1/nonexistent'], messageBus),
      ).rejects.toThrow('Owner execution failed: task not found');
    });

    it('distinguishes between "no owner" and "owner error"', async () => {
      // No handler = no owner (should return no-handler outcome)
      const noOwner = await tryDelegateExec(['run', '/path/to/plan.yaml'], messageBus);
      expect(noOwner.kind).toBe('no-handler');

      // Handler registered = owner present
      messageBus.onRequest('headless.exec', async () => {
        throw new Error('Owner error');
      });

      // Owner error should throw, not return a non-delegated outcome
      await expect(tryDelegateExec(['run', '/path/to/plan.yaml'], messageBus)).rejects.toThrow(
        'Owner error',
      );
    });
  });

  describe('deterministic delegation behavior', () => {
    it('always delegates when owner is available (no race conditions)', async () => {
      const ownerHandler = vi.fn(async () => ({ ok: true }));
      messageBus.onRequest('headless.exec', ownerHandler);

      // Run multiple delegations in sequence
      for (let i = 0; i < 5; i++) {
        const outcome = await tryDelegateExec(['approve', `task-${i}`], messageBus);
        expect(outcome.kind).toBe('delegated');
      }

      expect(ownerHandler).toHaveBeenCalledTimes(5);
    });

    it('always falls back when owner is unavailable (no race conditions)', async () => {
      // Run multiple attempts with no owner
      for (let i = 0; i < 5; i++) {
        const outcome = await tryDelegateExec(['approve', `task-${i}`], messageBus);
        expect(outcome.kind).toBe('no-handler');
      }
    });
  });

  describe('tryDelegateRun / tryDelegateResume', () => {
    it('succeeds when owner handler returns immediately (fire-and-forget execution)', async () => {
      // Simulate owner handler that returns response immediately without awaiting
      // task execution — the fix for the 5s delegation timeout bug.
      messageBus.onRequest('headless.run', async (req: { planPath: string }) => {
        expect(req.planPath).toContain('plan.yaml');
        // Return immediately (tasks execute in background via fire-and-forget)
        return {
          workflowId: 'wf-test-123',
          tasks: [
            { id: 'wf-test-123/task-1', status: 'running', config: { workflowId: 'wf-test-123' }, execution: {} },
          ],
        };
      });

      // With noTrack=true, delegation returns after receiving the response
      // without waiting for task settlement.
      const outcome = await tryDelegateRun('/path/to/plan.yaml', messageBus, false, true);
      expect(outcome.kind).toBe('delegated');
      if (outcome.kind === 'delegated') {
        expect(outcome.workflowId).toBe('wf-test-123');
        expect(outcome.tasks).toHaveLength(1);
      }
    });

    it('times out when owner handler blocks on task execution (pre-fix behavior)', async () => {
      // Simulate the old bug: handler awaits executeTasks which never resolves
      messageBus.onRequest('headless.run', async () => {
        return new Promise(() => {}); // Never resolves — simulates await executeTasks()
      });

      const outcome = await tryDelegateRun('/path/to/plan.yaml', messageBus, false, true);
      // Delegation fails because the 5s timeout fires before the handler responds
      expect(outcome.kind).toBe('timeout');
    }, 10_000);

    it('resume handler returns immediately with fire-and-forget execution', async () => {
      messageBus.onRequest('headless.resume', async (req: { workflowId: string }) => {
        expect(req.workflowId).toBe('wf-existing');
        return {
          workflowId: 'wf-existing',
          tasks: [
            { id: 'wf-existing/task-1', status: 'running', config: { workflowId: 'wf-existing' }, execution: {} },
          ],
        };
      });

      const outcome = await tryDelegateResume('wf-existing', messageBus, false, true);
      expect(outcome.kind).toBe('delegated');
      if (outcome.kind === 'delegated') {
        expect(outcome.workflowId).toBe('wf-existing');
        expect(outcome.tasks).toHaveLength(1);
      }
    });
  });

  describe('protocol-error on malformed owner responses', () => {
    it('returns protocol-error when owner returns null', async () => {
      messageBus.onRequest('headless.exec', async () => null);

      const outcome = await tryDelegateExec(['approve', 'wf-1/task-1'], messageBus);
      expect(outcome.kind).toBe('protocol-error');
      if (outcome.kind === 'protocol-error') {
        expect(outcome.message).toContain('null');
      }
    });

    it('returns protocol-error when owner returns a string', async () => {
      messageBus.onRequest('headless.exec', async () => 'unexpected-string');

      const outcome = await tryDelegateExec(['approve', 'wf-1/task-1'], messageBus);
      expect(outcome.kind).toBe('protocol-error');
      if (outcome.kind === 'protocol-error') {
        expect(outcome.message).toContain('string');
      }
    });

    it('returns protocol-error when owner returns a number', async () => {
      messageBus.onRequest('headless.exec', async () => 42);

      const outcome = await tryDelegateExec(['approve', 'wf-1/task-1'], messageBus);
      expect(outcome.kind).toBe('protocol-error');
      if (outcome.kind === 'protocol-error') {
        expect(outcome.message).toContain('number');
      }
    });

    it('returns protocol-error when response has workflowId but tasks is not an array', async () => {
      messageBus.onRequest('headless.run', async () => ({
        workflowId: 'wf-test',
        tasks: 'not-an-array',
      }));

      const outcome = await tryDelegateRun('/plan.yaml', messageBus, false, true);
      expect(outcome.kind).toBe('protocol-error');
      if (outcome.kind === 'protocol-error') {
        expect(outcome.message).toContain('tasks');
        expect(outcome.message).toContain('expected array');
      }
    });

    it('returns protocol-error when response has workflowId but tasks is missing', async () => {
      messageBus.onRequest('headless.run', async () => ({
        workflowId: 'wf-test',
      }));

      const outcome = await tryDelegateRun('/plan.yaml', messageBus, false, true);
      expect(outcome.kind).toBe('protocol-error');
      if (outcome.kind === 'protocol-error') {
        expect(outcome.message).toContain('tasks');
      }
    });

    it('returns protocol-error when response has neither workflowId nor ok', async () => {
      messageBus.onRequest('headless.exec', async () => ({
        success: true,
        someOtherField: 123,
      }));

      const outcome = await tryDelegateExec(['approve', 'wf-1/task-1'], messageBus);
      expect(outcome.kind).toBe('protocol-error');
      if (outcome.kind === 'protocol-error') {
        expect(outcome.message).toContain('neither workflowId');
        expect(outcome.message).toContain('ok');
      }
    });

    it('returns protocol-error when workflowId is a number instead of string', async () => {
      messageBus.onRequest('headless.run', async () => ({
        workflowId: 12345,
        tasks: [],
      }));

      const outcome = await tryDelegateRun('/plan.yaml', messageBus, false, true);
      // workflowId is not a string, so it doesn't match the workflow shape.
      // And ok is not true, so it fails the fallback check too.
      expect(outcome.kind).toBe('protocol-error');
    });

    it('accepts valid { ok: true } response as delegated', async () => {
      messageBus.onRequest('headless.exec', async () => ({ ok: true }));

      const outcome = await tryDelegateExec(['approve', 'wf-1/task-1'], messageBus);
      expect(outcome.kind).toBe('delegated');
    });

    it('accepts valid workflow response as delegated', async () => {
      messageBus.onRequest('headless.run', async () => ({
        workflowId: 'wf-valid',
        tasks: [{ id: 'wf-valid/t1', status: 'running' }],
      }));

      const outcome = await tryDelegateRun('/plan.yaml', messageBus, false, true);
      expect(outcome.kind).toBe('delegated');
      if (outcome.kind === 'delegated') {
        expect(outcome.workflowId).toBe('wf-valid');
        expect(outcome.tasks).toHaveLength(1);
      }
    });
  });
});
