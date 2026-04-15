import { describe, it, expect } from 'vitest';
import {
  evaluateFallbackDecision,
  applyFallbackDecision,
  taskUpdate,
  type FallbackPolicyContext,
} from '../fallback-policy.js';
import { createTaskState } from '@invoker/workflow-graph';

describe('fallback-policy', () => {
  describe('evaluateFallbackDecision (Result-based API)', () => {
    it('should return retry decision for autoFix tasks that failed', async () => {
      const task = createTaskState('task1', 'Test task', [], { autoFix: true });
      const context: FallbackPolicyContext = {
        task,
        exitCode: 1,
      };

      const result = await evaluateFallbackDecision(context);

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.type).toBe('retry');
        expect(result.value.reason).toBe('Auto-fix enabled');
      }
    });

    it('should return skip decision for blocked tasks', async () => {
      const task = createTaskState('task1', 'Test task', []);
      const blockedTask = { ...task, status: 'blocked' as const };
      const context: FallbackPolicyContext = {
        task: blockedTask,
      };

      const result = await evaluateFallbackDecision(context);

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.type).toBe('skip');
        expect(result.value.reason).toBe('Task is blocked');
      }
    });

    it('should return proceed decision for completed tasks', async () => {
      const task = createTaskState('task1', 'Test task', []);
      const completedTask = { ...task, status: 'completed' as const };
      const context: FallbackPolicyContext = {
        task: completedTask,
      };

      const result = await evaluateFallbackDecision(context);

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.type).toBe('proceed');
        expect(result.value.reason).toBe('Task completed successfully');
      }
    });

    it('should return fail decision when error is present', async () => {
      const task = createTaskState('task1', 'Test task', []);
      const context: FallbackPolicyContext = {
        task,
        error: 'Command failed',
        exitCode: 1,
      };

      const result = await evaluateFallbackDecision(context);

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.type).toBe('fail');
        expect(result.value.reason).toBe('Command failed');
      }
    });

    it('should return proceed decision when no error condition', async () => {
      const task = createTaskState('task1', 'Test task', []);
      const context: FallbackPolicyContext = {
        task,
        exitCode: 0,
      };

      const result = await evaluateFallbackDecision(context);

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.type).toBe('proceed');
        expect(result.value.reason).toBe('No error condition detected');
      }
    });
  });

  describe('applyFallbackDecision (throw-based API)', () => {
    it('should return decision without throwing for valid context', async () => {
      const task = createTaskState('task1', 'Test task', [], { autoFix: true });
      const context: FallbackPolicyContext = {
        task,
        exitCode: 1,
      };

      const decision = await applyFallbackDecision(context);

      expect(decision.type).toBe('retry');
      expect(decision.reason).toBe('Auto-fix enabled');
    });

    it('should preserve throw semantics on error', async () => {
      // Note: Current implementation doesn't actually throw unless ResultAsync fails
      // This test documents the expected behavior when errors occur
      const task = createTaskState('task1', 'Test task', []);
      const context: FallbackPolicyContext = {
        task,
        error: 'Test error',
      };

      const decision = await applyFallbackDecision(context);

      // Currently returns fail decision rather than throwing
      expect(decision.type).toBe('fail');
    });
  });

  describe('taskUpdate helper', () => {
    it('should provide applyFallback method on task', async () => {
      const task = createTaskState('task1', 'Test task', [], { autoFix: true });
      const taskWithExecution = {
        ...task,
        execution: { exitCode: 1, error: 'Test error' },
      };

      const decision = await taskUpdate(taskWithExecution).applyFallback();

      expect(decision.type).toBe('retry');
      expect(decision.reason).toBe('Auto-fix enabled');
    });

    it('should allow context overrides', async () => {
      const task = createTaskState('task1', 'Test task', []);
      const taskWithExecution = {
        ...task,
        execution: {},
      };

      const decision = await taskUpdate(taskWithExecution).applyFallback({
        error: 'Override error',
        exitCode: 2,
      });

      expect(decision.type).toBe('fail');
      expect(decision.reason).toBe('Override error');
    });

    it('should extract context from task execution', async () => {
      const task = createTaskState('task1', 'Test task', []);
      const completedTask = {
        ...task,
        status: 'completed' as const,
        execution: { exitCode: 0 },
      };

      const decision = await taskUpdate(completedTask).applyFallback();

      expect(decision.type).toBe('proceed');
    });
  });
});
