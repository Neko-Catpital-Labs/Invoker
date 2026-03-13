import { describe, it, expect } from 'vitest';
import { ResourceEstimator } from '../resource-estimator.js';
import { createTaskState } from '../task-types.js';
import type { TaskState } from '../task-types.js';

function makeTask(overrides: { command?: string; prompt?: string; isMergeNode?: boolean; isReconciliation?: boolean; startedAt?: Date; completedAt?: Date } = {}): TaskState {
  const { command, prompt, isMergeNode, isReconciliation, startedAt, completedAt } = overrides;
  const task = createTaskState('t1', 'Test task', [], {
    command,
    prompt,
    isMergeNode: isMergeNode ?? false,
    isReconciliation,
  });
  return {
    ...task,
    status: startedAt && completedAt ? 'completed' : 'pending',
    execution: { startedAt, completedAt },
  };
}

describe('ResourceEstimator', () => {
  describe('heuristic weights', () => {
    it('returns 0 for merge nodes', () => {
      const estimator = new ResourceEstimator();
      expect(estimator.estimateWeight(makeTask({ isMergeNode: true }))).toBe(0);
    });

    it('returns 0 for reconciliation tasks', () => {
      const estimator = new ResourceEstimator();
      expect(estimator.estimateWeight(makeTask({ isReconciliation: true }))).toBe(0);
    });

    it('returns 3 for test commands', () => {
      const estimator = new ResourceEstimator();
      expect(estimator.estimateWeight(makeTask({ command: 'cd packages/core && pnpm test' }))).toBe(3);
      expect(estimator.estimateWeight(makeTask({ command: 'npm test' }))).toBe(3);
      expect(estimator.estimateWeight(makeTask({ command: 'vitest run' }))).toBe(3);
      expect(estimator.estimateWeight(makeTask({ command: 'jest --coverage' }))).toBe(3);
      expect(estimator.estimateWeight(makeTask({ command: 'pytest -v' }))).toBe(3);
      expect(estimator.estimateWeight(makeTask({ command: 'cargo test' }))).toBe(3);
      expect(estimator.estimateWeight(makeTask({ command: 'go test ./...' }))).toBe(3);
    });

    it('returns 2 for build commands', () => {
      const estimator = new ResourceEstimator();
      expect(estimator.estimateWeight(makeTask({ command: 'pnpm build' }))).toBe(2);
      expect(estimator.estimateWeight(makeTask({ command: 'npm run build' }))).toBe(2);
      expect(estimator.estimateWeight(makeTask({ command: 'tsc --noEmit' }))).toBe(2);
      expect(estimator.estimateWeight(makeTask({ command: 'webpack --mode production' }))).toBe(2);
      expect(estimator.estimateWeight(makeTask({ command: 'vite build' }))).toBe(2);
    });

    it('returns 1 for prompt-only tasks (claude)', () => {
      const estimator = new ResourceEstimator();
      expect(estimator.estimateWeight(makeTask({ prompt: 'Refactor this module' }))).toBe(1);
    });

    it('returns 1 for generic commands', () => {
      const estimator = new ResourceEstimator();
      expect(estimator.estimateWeight(makeTask({ command: 'echo hello' }))).toBe(1);
      expect(estimator.estimateWeight(makeTask({ command: 'ls -la' }))).toBe(1);
    });

    it('returns 1 for tasks with no command or prompt', () => {
      const estimator = new ResourceEstimator();
      expect(estimator.estimateWeight(makeTask())).toBe(1);
    });
  });

  describe('historical weights', () => {
    it('overrides heuristic with historical average duration', () => {
      const estimator = new ResourceEstimator();
      const now = new Date();

      const task = makeTask({
        command: 'echo hello',
        startedAt: new Date(now.getTime() - 120_000),
        completedAt: now,
      });
      estimator.recordCompletion(task);

      // "echo hello" heuristic would be 1, but it took 120s => weight 3
      const newTask = makeTask({ command: 'echo hello' });
      expect(estimator.estimateWeight(newTask)).toBe(3);
    });

    it('uses average of multiple completions', () => {
      const estimator = new ResourceEstimator();
      const now = new Date();

      // Two runs: 5s and 15s => average 10s => weight 2
      estimator.recordCompletion(makeTask({
        command: 'custom-script',
        startedAt: new Date(now.getTime() - 5_000),
        completedAt: now,
      }));
      estimator.recordCompletion(makeTask({
        command: 'custom-script',
        startedAt: new Date(now.getTime() - 15_000),
        completedAt: now,
      }));

      expect(estimator.estimateWeight(makeTask({ command: 'custom-script' }))).toBe(2);
    });

    it('maps short durations (<10s) to weight 1', () => {
      const estimator = new ResourceEstimator();
      const now = new Date();
      estimator.recordCompletion(makeTask({
        command: 'fast-cmd',
        startedAt: new Date(now.getTime() - 3_000),
        completedAt: now,
      }));
      expect(estimator.estimateWeight(makeTask({ command: 'fast-cmd' }))).toBe(1);
    });

    it('maps medium durations (10-60s) to weight 2', () => {
      const estimator = new ResourceEstimator();
      const now = new Date();
      estimator.recordCompletion(makeTask({
        command: 'medium-cmd',
        startedAt: new Date(now.getTime() - 30_000),
        completedAt: now,
      }));
      expect(estimator.estimateWeight(makeTask({ command: 'medium-cmd' }))).toBe(2);
    });

    it('maps long durations (>60s) to weight 3', () => {
      const estimator = new ResourceEstimator();
      const now = new Date();
      estimator.recordCompletion(makeTask({
        command: 'slow-cmd',
        startedAt: new Date(now.getTime() - 90_000),
        completedAt: now,
      }));
      expect(estimator.estimateWeight(makeTask({ command: 'slow-cmd' }))).toBe(3);
    });

    it('ignores tasks without startedAt or completedAt', () => {
      const estimator = new ResourceEstimator();
      estimator.recordCompletion(makeTask({ command: 'partial' }));
      // No history recorded, falls back to heuristic
      expect(estimator.estimateWeight(makeTask({ command: 'partial' }))).toBe(1);
    });
  });

  describe('loadHistory', () => {
    it('bootstraps from completed tasks', () => {
      const estimator = new ResourceEstimator();
      const now = new Date();

      const tasks = [
        makeTask({
          command: 'pnpm test',
          startedAt: new Date(now.getTime() - 45_000),
          completedAt: now,
        }),
        makeTask({ command: 'pnpm test' }), // pending, should be ignored
      ];

      estimator.loadHistory(tasks);

      // Historical 45s => weight 2, overriding heuristic of 3
      expect(estimator.estimateWeight(makeTask({ command: 'pnpm test' }))).toBe(2);
    });
  });

  describe('normalizeCommand', () => {
    it('strips hex hashes', () => {
      const estimator = new ResourceEstimator();
      expect(estimator.normalizeCommand('git checkout abc123def456')).toBe('git checkout <hash>');
    });

    it('strips timestamps', () => {
      const estimator = new ResourceEstimator();
      expect(estimator.normalizeCommand('wf-1773277427564-4')).toBe('wf-<ts>-4');
    });

    it('strips tmp paths', () => {
      const estimator = new ResourceEstimator();
      expect(estimator.normalizeCommand('cd /tmp/worktree-abc && pnpm test'))
        .toBe('cd <tmpdir> && pnpm test');
    });

    it('returns undefined for undefined input', () => {
      const estimator = new ResourceEstimator();
      expect(estimator.normalizeCommand(undefined)).toBeUndefined();
    });
  });
});
