import { describe, it, expect } from 'vitest';
import { ResourceEstimator, UTILIZATION_MAX } from '../resource-estimator.js';
import { createTaskState } from '../task-types.js';
import type { TaskState } from '../task-types.js';

function makeTask(overrides: {
  command?: string;
  prompt?: string;
  isMergeNode?: boolean;
  isReconciliation?: boolean;
  utilization?: number;
} = {}): TaskState {
  const { command, prompt, isMergeNode, isReconciliation, utilization } = overrides;
  return createTaskState('t1', 'Test task', [], {
    command,
    prompt,
    isMergeNode: isMergeNode ?? false,
    isReconciliation,
    utilization,
  });
}

describe('ResourceEstimator', () => {
  describe('per-task config.utilization', () => {
    it('uses config.utilization when set', () => {
      const estimator = new ResourceEstimator();
      expect(estimator.estimateUtilization(makeTask({ utilization: 75 }))).toBe(75);
    });

    it('uses UTILIZATION_MAX when set on task', () => {
      const estimator = new ResourceEstimator();
      expect(estimator.estimateUtilization(makeTask({ utilization: UTILIZATION_MAX }))).toBe(UTILIZATION_MAX);
    });

    it('uses 0 utilization when explicitly set to 0', () => {
      const estimator = new ResourceEstimator();
      expect(estimator.estimateUtilization(makeTask({ utilization: 0 }))).toBe(0);
    });
  });

  describe('built-in heuristics', () => {
    it('returns 0 for merge nodes', () => {
      const estimator = new ResourceEstimator();
      expect(estimator.estimateUtilization(makeTask({ isMergeNode: true }))).toBe(0);
    });

    it('returns 0 for reconciliation tasks', () => {
      const estimator = new ResourceEstimator();
      expect(estimator.estimateUtilization(makeTask({ isReconciliation: true }))).toBe(0);
    });

    it('returns defaultUtilization (50) for generic commands', () => {
      const estimator = new ResourceEstimator();
      expect(estimator.estimateUtilization(makeTask({ command: 'echo hello' }))).toBe(50);
    });

    it('returns defaultUtilization for prompt-only tasks', () => {
      const estimator = new ResourceEstimator();
      expect(estimator.estimateUtilization(makeTask({ prompt: 'Refactor module' }))).toBe(50);
    });

    it('returns defaultUtilization for tasks with no command or prompt', () => {
      const estimator = new ResourceEstimator();
      expect(estimator.estimateUtilization(makeTask())).toBe(50);
    });
  });

  describe('config rules', () => {
    it('matches first rule pattern in command', () => {
      const estimator = new ResourceEstimator([
        { pattern: 'pnpm test', utilization: UTILIZATION_MAX },
        { pattern: 'pnpm build', utilization: 80 },
      ]);
      expect(estimator.estimateUtilization(makeTask({ command: 'cd packages/core && pnpm test' }))).toBe(UTILIZATION_MAX);
      expect(estimator.estimateUtilization(makeTask({ command: 'pnpm build' }))).toBe(80);
    });

    it('first matching rule wins', () => {
      const estimator = new ResourceEstimator([
        { pattern: 'test', utilization: 90 },
        { pattern: 'pnpm test', utilization: 100 },
      ]);
      expect(estimator.estimateUtilization(makeTask({ command: 'pnpm test' }))).toBe(90);
    });

    it('falls through to defaultUtilization when no rule matches', () => {
      const estimator = new ResourceEstimator([
        { pattern: 'test', utilization: UTILIZATION_MAX },
      ]);
      expect(estimator.estimateUtilization(makeTask({ command: 'echo hello' }))).toBe(50);
    });

    it('skips rules for tasks without command', () => {
      const estimator = new ResourceEstimator([
        { pattern: 'test', utilization: UTILIZATION_MAX },
      ]);
      expect(estimator.estimateUtilization(makeTask({ prompt: 'do something' }))).toBe(50);
    });

    it('respects custom defaultUtilization', () => {
      const estimator = new ResourceEstimator([], 30);
      expect(estimator.estimateUtilization(makeTask({ command: 'echo hello' }))).toBe(30);
    });
  });

  describe('resolution order', () => {
    it('per-task config > merge/reconciliation > rules > default', () => {
      const estimator = new ResourceEstimator([
        { pattern: 'test', utilization: UTILIZATION_MAX },
      ], 50);

      const withConfig = makeTask({ command: 'pnpm test', utilization: 25 });
      expect(estimator.estimateUtilization(withConfig)).toBe(25);

      const mergeNode = makeTask({ isMergeNode: true });
      expect(estimator.estimateUtilization(mergeNode)).toBe(0);

      const testTask = makeTask({ command: 'pnpm test' });
      expect(estimator.estimateUtilization(testTask)).toBe(UTILIZATION_MAX);

      const genericTask = makeTask({ command: 'echo hi' });
      expect(estimator.estimateUtilization(genericTask)).toBe(50);
    });
  });

  describe('adjustForPool', () => {
    it('returns utilization unchanged (stub)', () => {
      const estimator = new ResourceEstimator();
      expect(estimator.adjustForPool(UTILIZATION_MAX, 'remote-1')).toBe(UTILIZATION_MAX);
      expect(estimator.adjustForPool(50, 'local')).toBe(50);
    });
  });
});
