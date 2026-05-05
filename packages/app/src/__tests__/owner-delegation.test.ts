import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { delegationTimeoutMs, tryDelegateExec, tryDelegateRun, tryDelegateResume } from '../headless.js';
import { LocalBus } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
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
    it('uses 60s timeout for workflow-scoped rebase', () => {
      expect(delegationTimeoutMs(['rebase', 'wf-1'], targetLookup)).toBe(60_000);
    });

    it('uses 60s timeout for workflow-scoped rebase-and-retry', () => {
      expect(delegationTimeoutMs(['rebase-and-retry', 'wf-1'], targetLookup)).toBe(60_000);
    });

    it('uses 60s timeout for workflow-scoped restart', () => {
      expect(delegationTimeoutMs(['restart', 'wf-123'], targetLookup)).toBe(60_000);
    });

    it('keeps task-scoped rebase at the default timeout', () => {
      expect(delegationTimeoutMs(['rebase', 'wf-123/task-1'], targetLookup)).toBe(5_000);
    });

    it('keeps non-matching workflow ids at the default timeout', () => {
      expect(delegationTimeoutMs(['restart', 'not-a-workflow-id'], targetLookup)).toBe(5_000);
    });

    it('keeps unrelated commands at the default timeout', () => {
      expect(delegationTimeoutMs(['approve', 'wf-123/task-1'], targetLookup)).toBe(5_000);
    });
  });

  describe('successful delegation when owner is present', () => {
    it('delegates mutation command to owner via RPC', async () => {
      // Simulate owner process registering a handler
      const ownerHandler = vi.fn(async (req: { args: string[] }) => {
        // Owner successfully executed the command
        return { success: true, workflowId: 'wf-test' };
      });

      messageBus.onRequest('headless.exec', ownerHandler);

      // Headless process attempts to delegate
      const delegated = await tryDelegateExec(['run', '/path/to/plan.yaml'], messageBus);

      // Verify delegation succeeded
      expect(delegated).toBe(true);
      expect(ownerHandler).toHaveBeenCalledWith({
        args: ['run', '/path/to/plan.yaml'],
        noTrack: undefined,
        waitForApproval: undefined,
      });
    });

    it('delegates with waitForApproval flag', async () => {
      const ownerHandler = vi.fn(async () => ({ success: true }));
      messageBus.onRequest('headless.exec', ownerHandler);

      await tryDelegateExec(['approve', 'task-1'], messageBus, true);

      expect(ownerHandler).toHaveBeenCalledWith({
        args: ['approve', 'task-1'],
        waitForApproval: true,
      });
    });

    it('delegates retry-task command to owner', async () => {
      const ownerHandler = vi.fn(async () => ({ success: true }));
      messageBus.onRequest('headless.exec', ownerHandler);

      const delegated = await tryDelegateExec(['retry-task', 'wf-1/task-1'], messageBus);

      expect(delegated).toBe(true);
      expect(ownerHandler).toHaveBeenCalledWith({
        args: ['retry-task', 'wf-1/task-1'],
        waitForApproval: undefined,
      });
    });

    it('delegates resume command to owner', async () => {
      const ownerHandler = vi.fn(async () => ({ success: true }));
      messageBus.onRequest('headless.exec', ownerHandler);

      const delegated = await tryDelegateExec(['resume', 'wf-1'], messageBus);

      expect(delegated).toBe(true);
      expect(ownerHandler).toHaveBeenCalledWith({
        args: ['resume', 'wf-1'],
        waitForApproval: undefined,
      });
    });

    it('delegates approve command to owner', async () => {
      const ownerHandler = vi.fn(async () => ({ success: true }));
      messageBus.onRequest('headless.exec', ownerHandler);

      const delegated = await tryDelegateExec(['approve', 'wf-1/task-1'], messageBus);

      expect(delegated).toBe(true);
      expect(ownerHandler).toHaveBeenCalledWith({
        args: ['approve', 'wf-1/task-1'],
        waitForApproval: undefined,
      });
    });

    it('delegates reject command to owner', async () => {
      const ownerHandler = vi.fn(async () => ({ success: true }));
      messageBus.onRequest('headless.exec', ownerHandler);

      const delegated = await tryDelegateExec(['reject', 'wf-1/task-1', 'reason text'], messageBus);

      expect(delegated).toBe(true);
      expect(ownerHandler).toHaveBeenCalledWith({
        args: ['reject', 'wf-1/task-1', 'reason text'],
        waitForApproval: undefined,
      });
    });

    it('delegates set command to owner', async () => {
      const ownerHandler = vi.fn(async () => ({ success: true }));
      messageBus.onRequest('headless.exec', ownerHandler);

      const delegated = await tryDelegateExec(
        ['set', 'command', 'wf-1/task-1', 'new command'],
        messageBus,
      );

      expect(delegated).toBe(true);
      expect(ownerHandler).toHaveBeenCalledWith({
        args: ['set', 'command', 'wf-1/task-1', 'new command'],
        waitForApproval: undefined,
      });
    });

    it('delegates rebase with noTrack so owner can return before workflow settlement', async () => {
      const ownerHandler = vi.fn(async () => ({ success: true }));
      messageBus.onRequest('headless.exec', ownerHandler);

      const delegated = await tryDelegateExec(
        ['rebase', 'wf-1/task-1'],
        messageBus,
        undefined,
        true,
      );

      expect(delegated).toBe(true);
      expect(ownerHandler).toHaveBeenCalledWith({
        args: ['rebase', 'wf-1/task-1'],
        noTrack: true,
        waitForApproval: undefined,
      });
    });
  });

  describe('fallback to standalone when owner is unavailable', () => {
    it('returns false when no owner handler is registered', async () => {
      // No handler registered — no owner present
      const delegated = await tryDelegateExec(['run', '/path/to/plan.yaml'], messageBus);

      // Should fall back to standalone mode
      expect(delegated).toBe(false);
    });

    it('returns false when delegation times out (owner unresponsive)', async () => {
      vi.useFakeTimers();
      messageBus.onRequest('headless.exec', async () => new Promise(() => {}));

      const delegatedPromise = tryDelegateExec(['approve', 'wf-1/task-1'], messageBus);
      const tracked = trackPromise(delegatedPromise);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(tracked.settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(delegatedPromise).resolves.toBe(false);
    });
  });

  describe('tryDelegateExec applies command-aware timeout selection deterministically', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      messageBus.onRequest('headless.exec', async () => new Promise(() => {}));
    });

    it.each([
      ['rebase', ['rebase', 'wf-1']],
      ['rebase-and-retry', ['rebase-and-retry', 'wf-1']],
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
      await expect(delegatedPromise).resolves.toBe(false);
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
      await expect(delegatedPromise).resolves.toBe(false);
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
      // No handler = no owner (should return false)
      const noOwner = await tryDelegateExec(['run', '/path/to/plan.yaml'], messageBus);
      expect(noOwner).toBe(false);

      // Handler registered = owner present
      messageBus.onRequest('headless.exec', async () => {
        throw new Error('Owner error');
      });

      // Owner error should throw, not return false
      await expect(tryDelegateExec(['run', '/path/to/plan.yaml'], messageBus)).rejects.toThrow(
        'Owner error',
      );
    });
  });

  describe('deterministic delegation behavior', () => {
    it('always delegates when owner is available (no race conditions)', async () => {
      const ownerHandler = vi.fn(async () => ({ success: true }));
      messageBus.onRequest('headless.exec', ownerHandler);

      // Run multiple delegations in sequence
      for (let i = 0; i < 5; i++) {
        const delegated = await tryDelegateExec(['approve', `task-${i}`], messageBus);
        expect(delegated).toBe(true);
      }

      expect(ownerHandler).toHaveBeenCalledTimes(5);
    });

    it('always falls back when owner is unavailable (no race conditions)', async () => {
      // Run multiple attempts with no owner
      for (let i = 0; i < 5; i++) {
        const delegated = await tryDelegateExec(['approve', `task-${i}`], messageBus);
        expect(delegated).toBe(false);
      }
    });
  });

  describe('tryDelegateRun / tryDelegateResume', () => {
    it('succeeds when GUI handler returns immediately (fire-and-forget execution)', async () => {
      // Simulate GUI handler that returns response immediately without awaiting
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
      const delegated = await tryDelegateRun('/path/to/plan.yaml', messageBus, false, true);
      expect(delegated).toBe(true);
    });

    it('times out when GUI handler blocks on task execution (pre-fix behavior)', async () => {
      // Simulate the old bug: handler awaits executeTasks which never resolves
      messageBus.onRequest('headless.run', async () => {
        return new Promise(() => {}); // Never resolves — simulates await executeTasks()
      });

      const delegated = await tryDelegateRun('/path/to/plan.yaml', messageBus, false, true);
      // Delegation fails because the 5s timeout fires before the handler responds
      expect(delegated).toBe(false);
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

      const delegated = await tryDelegateResume('wf-existing', messageBus, false, true);
      expect(delegated).toBe(true);
    });
  });
});
