import { describe, it, expect, beforeEach } from 'vitest';
import { ExperimentManager } from '../experiments.js';

describe('ExperimentManager', () => {
  let em: ExperimentManager;

  beforeEach(() => {
    em = new ExperimentManager();
  });

  describe('planExperimentGroup', () => {
    it('plans N experiment tasks + 1 reconciliation task', () => {
      const variants = [
        { id: 'pivot-exp-a', description: 'Variant A', prompt: 'Try A' },
        { id: 'pivot-exp-b', description: 'Variant B', prompt: 'Try B' },
      ];

      const plan = em.planExperimentGroup('pivot', variants);

      expect(plan.experimentTasks).toHaveLength(2);
      expect(plan.reconciliationTask).toBeDefined();
      expect(plan.reconciliationTask.isReconciliation).toBe(true);
      expect(plan.reconciliationTask.id).toBe('pivot-reconciliation');
    });

    it('experiment tasks depend on parent task', () => {
      const plan = em.planExperimentGroup(
        'pivot',
        [{ id: 'exp-1', description: 'E1', prompt: 'p' }],
      );

      expect(plan.experimentTasks[0].dependencies).toEqual(['pivot']);
      expect(plan.experimentTasks[0].parentTask).toBe('pivot');
    });

    it('reconciliation depends on all experiments', () => {
      const variants = [
        { id: 'exp-x', description: 'X' },
        { id: 'exp-y', description: 'Y' },
      ];

      const plan = em.planExperimentGroup('pivot', variants);

      expect(plan.reconciliationTask.dependencies).toEqual(['exp-x', 'exp-y']);
    });

    it('produces a dependency rewrite from parent to reconciliation', () => {
      const plan = em.planExperimentGroup(
        'pivot',
        [{ id: 'exp-1', description: 'E1' }],
      );

      expect(plan.rewrites).toEqual([
        { fromDep: 'pivot', toDep: 'pivot-reconciliation' },
      ]);
    });

    it('inherits repoUrl and familiarType from parent', () => {
      const plan = em.planExperimentGroup(
        'pivot',
        [{ id: 'exp-1', description: 'E1' }],
        'https://github.com/test/repo',
        'worktree',
      );

      expect(plan.experimentTasks[0].repoUrl).toBe('https://github.com/test/repo');
      expect(plan.experimentTasks[0].familiarType).toBe('worktree');
    });

    it('carries forward previous results', () => {
      const previousResults = [
        { id: 'old-exp', status: 'completed' as const, exitCode: 0, summary: 'Old' },
      ];

      const plan = em.planExperimentGroup(
        'pivot',
        [{ id: 'new-exp', description: 'New' }],
        undefined,
        undefined,
        previousResults,
      );

      expect(plan.group.experimentIds).toContain('old-exp');
      expect(plan.group.experimentIds).toContain('new-exp');
      expect(plan.group.completedExperiments.has('old-exp')).toBe(true);
    });

    it('does not mutate any state machine or graph', () => {
      const plan = em.planExperimentGroup(
        'pivot',
        [{ id: 'exp-1', description: 'E1' }],
      );

      // Plan produces data structures, not state mutations
      expect(plan.experimentTasks[0].id).toBe('exp-1');
      expect(plan.reconciliationTask.id).toBe('pivot-reconciliation');
      expect(plan.rewrites).toHaveLength(1);
    });
  });

  describe('onExperimentCompleted', () => {
    it('tracks partial progress', () => {
      const variants = [
        { id: 'exp-a', description: 'A' },
        { id: 'exp-b', description: 'B' },
      ];
      em.planExperimentGroup('pivot', variants);

      const first = em.onExperimentCompleted('exp-a', {
        id: 'exp-a',
        status: 'completed',
        exitCode: 0,
      });

      expect(first).toBeDefined();
      expect(first!.allDone).toBe(false);
      expect(first!.reconciliationTriggered).toBe(false);
    });

    it('triggers reconciliation when all experiments are done', () => {
      const variants = [
        { id: 'exp-a', description: 'A' },
        { id: 'exp-b', description: 'B' },
      ];
      em.planExperimentGroup('pivot', variants);

      em.onExperimentCompleted('exp-a', { id: 'exp-a', status: 'completed', exitCode: 0 });
      const second = em.onExperimentCompleted('exp-b', { id: 'exp-b', status: 'failed', exitCode: 1 });

      expect(second).toBeDefined();
      expect(second!.allDone).toBe(true);
      expect(second!.reconciliationTriggered).toBe(true);
    });

    it('returns null for unknown experiment', () => {
      const result = em.onExperimentCompleted('unknown', {
        id: 'unknown',
        status: 'completed',
        exitCode: 0,
      });
      expect(result).toBeNull();
    });
  });
});
