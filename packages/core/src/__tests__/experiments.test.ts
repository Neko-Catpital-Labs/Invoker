import { describe, it, expect, beforeEach } from 'vitest';
import { ExperimentManager } from '../experiments.js';
import { TaskStateMachine } from '../state-machine.js';

describe('ExperimentManager', () => {
  let sm: TaskStateMachine;
  let em: ExperimentManager;

  beforeEach(() => {
    sm = new TaskStateMachine();
    em = new ExperimentManager();
  });

  describe('createExperimentGroup', () => {
    it('spawns N experiments + 1 reconciliation task', () => {
      sm.createTask('pivot', 'Pivot task', []);
      sm.startTask('pivot');
      sm.completeTask('pivot');

      const variants = [
        { id: 'pivot-exp-a', description: 'Variant A', prompt: 'Try A' },
        { id: 'pivot-exp-b', description: 'Variant B', prompt: 'Try B' },
      ];

      const result = em.createExperimentGroup('pivot', variants, sm);

      expect(result.experiments).toHaveLength(2);
      expect(result.reconciliationTask).toBeDefined();
      expect(result.reconciliationTask.isReconciliation).toBe(true);
      expect(result.reconciliationTask.id).toBe('pivot-reconciliation');
    });

    it('experiments depend on parent task', () => {
      sm.createTask('pivot', 'Pivot', []);
      sm.startTask('pivot');
      sm.completeTask('pivot');

      const result = em.createExperimentGroup(
        'pivot',
        [{ id: 'exp-1', description: 'E1' }],
        sm,
      );

      expect(result.experiments[0].dependencies).toEqual(['pivot']);
      expect(result.experiments[0].parentTask).toBe('pivot');
    });

    it('reconciliation depends on all experiments', () => {
      sm.createTask('pivot', 'Pivot', []);
      sm.startTask('pivot');
      sm.completeTask('pivot');

      const variants = [
        { id: 'exp-x', description: 'X' },
        { id: 'exp-y', description: 'Y' },
      ];

      const result = em.createExperimentGroup('pivot', variants, sm);

      expect(result.reconciliationTask.dependencies).toEqual(['exp-x', 'exp-y']);
    });

    it('rewires downstream tasks to depend on reconciliation instead of pivot', () => {
      sm.createTask('pivot', 'Pivot', []);
      sm.createTask('downstream', 'Down', ['pivot']);

      const result = em.createExperimentGroup(
        'pivot',
        [{ id: 'exp-1', description: 'E1' }],
        sm,
      );

      // Downstream should now depend on reconciliation, not pivot
      const downstream = sm.getTask('downstream');
      expect(downstream?.dependencies).toEqual([result.reconciliationTask.id]);
    });

    it('carries forward previous results', () => {
      sm.createTask('pivot', 'Pivot', []);

      const previousResults = [
        { id: 'old-exp', status: 'completed' as const, exitCode: 0, summary: 'Old' },
      ];

      const result = em.createExperimentGroup(
        'pivot',
        [{ id: 'new-exp', description: 'New' }],
        sm,
        previousResults,
      );

      expect(result.group.experimentIds).toContain('old-exp');
      expect(result.group.experimentIds).toContain('new-exp');
      expect(result.group.completedExperiments.has('old-exp')).toBe(true);
    });
  });

  describe('onExperimentCompleted', () => {
    it('tracks partial progress', () => {
      sm.createTask('pivot', 'Pivot', []);

      const variants = [
        { id: 'exp-a', description: 'A' },
        { id: 'exp-b', description: 'B' },
      ];
      em.createExperimentGroup('pivot', variants, sm);

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
      sm.createTask('pivot', 'Pivot', []);

      const variants = [
        { id: 'exp-a', description: 'A' },
        { id: 'exp-b', description: 'B' },
      ];
      em.createExperimentGroup('pivot', variants, sm);

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
