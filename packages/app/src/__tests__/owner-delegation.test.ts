import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tryDelegateExec } from '../headless.js';
import { LocalBus } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';

/**
 * Regression tests for headless→owner RPC delegation.
 *
 * These tests verify that when a headless process (non-owner) attempts a mutation
 * and an owner process is available, the command is successfully delegated via
 * MessageBus RPC and executed by the owner.
 */
describe('headless→owner delegation', () => {
  let messageBus: MessageBus;

  beforeEach(() => {
    messageBus = new LocalBus();
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

    it('delegates restart command to owner', async () => {
      const ownerHandler = vi.fn(async () => ({ success: true }));
      messageBus.onRequest('headless.exec', ownerHandler);

      const delegated = await tryDelegateExec(['restart', 'wf-1/task-1'], messageBus);

      expect(delegated).toBe(true);
      expect(ownerHandler).toHaveBeenCalledWith({
        args: ['restart', 'wf-1/task-1'],
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
  });

  describe('fallback to standalone when owner is unavailable', () => {
    it('returns false when no owner handler is registered', async () => {
      // No handler registered — no owner present
      const delegated = await tryDelegateExec(['run', '/path/to/plan.yaml'], messageBus);

      // Should fall back to standalone mode
      expect(delegated).toBe(false);
    });

    it('returns false when delegation times out (owner unresponsive)', async () => {
      // Register handler that hangs (never resolves)
      messageBus.onRequest('headless.exec', async () => {
        return new Promise(() => {}); // Never resolves
      });

      // Should timeout after 5 seconds and return false
      const delegated = await tryDelegateExec(['run', '/path/to/plan.yaml'], messageBus);

      expect(delegated).toBe(false);
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
        tryDelegateExec(['restart', 'wf-1/nonexistent'], messageBus),
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
});
