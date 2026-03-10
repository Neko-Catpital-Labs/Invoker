import { describe, it, expect, beforeEach } from 'vitest';
import { ResponseHandler } from '../response-handler.js';
import { TaskStateMachine } from '../state-machine.js';
import { ExperimentManager } from '../experiments.js';
import type { WorkResponse } from '@invoker/protocol';

describe('ResponseHandler', () => {
  let sm: TaskStateMachine;
  let em: ExperimentManager;
  let handler: ResponseHandler;

  beforeEach(() => {
    sm = new TaskStateMachine();
    em = new ExperimentManager();
    handler = new ResponseHandler({ stateMachine: sm, experimentManager: em });
  });

  function makeResponse(overrides: Partial<WorkResponse>): WorkResponse {
    return {
      requestId: 'req-1',
      actionId: 't1',
      status: 'completed',
      outputs: { exitCode: 0 },
      ...overrides,
    };
  }

  describe('completed', () => {
    it('marks task complete and returns ready tasks', () => {
      sm.createTask('t1', 'First', []);
      sm.createTask('t2', 'Second', ['t1']);
      sm.startTask('t1');

      const result = handler.handleResponse(makeResponse({ status: 'completed' }));
      expect(result.success).toBe(true);
      expect(result.readyTasks).toContain('t2');
      expect(sm.getTask('t1')?.status).toBe('completed');
    });
  });

  describe('failed', () => {
    it('marks task failed and returns blocked tasks', () => {
      sm.createTask('t1', 'First', []);
      sm.createTask('t2', 'Second', ['t1']);
      sm.startTask('t1');

      const result = handler.handleResponse(
        makeResponse({ status: 'failed', outputs: { exitCode: 1, error: 'boom' } }),
      );
      expect(result.success).toBe(true);
      expect(result.blockedTasks).toContain('t2');
      expect(sm.getTask('t1')?.status).toBe('failed');
    });
  });

  describe('needs_input', () => {
    it('pauses task with prompt', () => {
      sm.createTask('t1', 'Task', []);
      sm.startTask('t1');

      const result = handler.handleResponse(
        makeResponse({ status: 'needs_input', outputs: { summary: 'What now?' } }),
      );
      expect(result.success).toBe(true);
      expect(sm.getTask('t1')?.status).toBe('needs_input');
      expect(sm.getTask('t1')?.inputPrompt).toBe('What now?');
    });
  });

  describe('spawn_experiments', () => {
    it('creates experiment group and rewrites dependencies', () => {
      sm.createTask('t1', 'Pivot', []);
      sm.createTask('downstream', 'Down', ['t1']);
      sm.startTask('t1');

      const result = handler.handleResponse(
        makeResponse({
          status: 'spawn_experiments',
          dagMutation: {
            spawnExperiments: {
              description: 'Try variants',
              variants: [
                { id: 'v1', prompt: 'A' },
                { id: 'v2', prompt: 'B' },
              ],
            },
          },
        }),
      );

      expect(result.success).toBe(true);
      expect(result.readyTasks).toBeDefined();

      // Experiments should exist
      expect(sm.getTask('t1-exp-v1')).toBeDefined();
      expect(sm.getTask('t1-exp-v2')).toBeDefined();

      // Reconciliation should exist
      expect(sm.getTask('t1-reconciliation')).toBeDefined();
      expect(sm.getTask('t1-reconciliation')?.isReconciliation).toBe(true);

      // Downstream should depend on reconciliation
      expect(sm.getTask('downstream')?.dependencies).toContain('t1-reconciliation');
    });

    it('spawn_experiments response includes parent task completion delta', () => {
      sm.createTask('t1', 'Pivot', []);
      sm.startTask('t1');

      const result = handler.handleResponse(
        makeResponse({
          status: 'spawn_experiments',
          dagMutation: {
            spawnExperiments: {
              description: 'Try variants',
              variants: [
                { id: 'v1', prompt: 'A' },
              ],
            },
          },
        }),
      );

      expect(result.success).toBe(true);
      expect(result.deltas).toBeDefined();

      // The first delta should be the parent task completion (updated type)
      const parentDelta = result.deltas!.find(
        (d) => d.type === 'updated' && d.taskId === 't1',
      );
      expect(parentDelta).toBeDefined();
      expect(parentDelta!.type).toBe('updated');
      if (parentDelta!.type === 'updated') {
        expect(parentDelta!.changes.status).toBe('completed');
      }

      // Parent task should now be completed in the state machine
      expect(sm.getTask('t1')?.status).toBe('completed');
    });

    it('spawn_experiments deltas are ordered: parent completion first, then experiment creations', () => {
      sm.createTask('t1', 'Pivot', []);
      sm.startTask('t1');

      const result = handler.handleResponse(
        makeResponse({
          status: 'spawn_experiments',
          dagMutation: {
            spawnExperiments: {
              description: 'Try variants',
              variants: [
                { id: 'v1', prompt: 'A' },
                { id: 'v2', prompt: 'B' },
              ],
            },
          },
        }),
      );

      expect(result.success).toBe(true);
      const deltas = result.deltas!;

      // First delta: parent task completion (updated)
      expect(deltas[0].type).toBe('updated');
      if (deltas[0].type === 'updated') {
        expect(deltas[0].taskId).toBe('t1');
        expect(deltas[0].changes.status).toBe('completed');
      }

      // Remaining deltas: experiment creations and reconciliation
      const createdDeltas = deltas.filter((d) => d.type === 'created');
      expect(createdDeltas.length).toBeGreaterThanOrEqual(2); // at least 2 experiments + recon
    });
  });

  describe('select_experiment', () => {
    it('completes reconciliation with selected experiment', () => {
      sm.createTask('pivot', 'Pivot', []);
      sm.createTask('recon', 'Reconciliation', [], { isReconciliation: true });
      sm.createTask('downstream', 'Down', ['recon']);

      // Set up reconciliation state
      sm.triggerReconciliation('recon', [
        { id: 'exp1', status: 'completed', exitCode: 0 },
      ]);

      const result = handler.handleResponse(
        makeResponse({
          actionId: 'recon',
          status: 'select_experiment',
          dagMutation: { selectExperiment: { experimentId: 'exp1' } },
        }),
      );

      expect(result.success).toBe(true);
      expect(sm.getTask('recon')?.status).toBe('completed');
      expect(sm.getTask('recon')?.selectedExperiment).toBe('exp1');
      expect(result.readyTasks).toContain('downstream');
    });
  });

  describe('commitHash flow-through', () => {
    it('stores commitHash on the task when response includes outputs.commitHash', () => {
      sm.createTask('t1', 'Task with commit', []);
      sm.startTask('t1');

      const result = handler.handleResponse(
        makeResponse({
          actionId: 't1',
          status: 'completed',
          outputs: { exitCode: 0, commitHash: 'abc123' },
        }),
      );

      expect(result.success).toBe(true);
      expect(sm.getTask('t1')?.status).toBe('completed');
      expect(sm.getTask('t1')?.commit).toBe('abc123');
    });
  });

  describe('claudeSessionId flow-through', () => {
    it('stores claudeSessionId on the task when response includes it', () => {
      sm.createTask('t1', 'Claude task', []);
      sm.startTask('t1');

      const result = handler.handleResponse(
        makeResponse({
          actionId: 't1',
          status: 'completed',
          outputs: { exitCode: 0, claudeSessionId: 'sess-456' },
        }),
      );

      expect(result.success).toBe(true);
      expect(sm.getTask('t1')?.claudeSessionId).toBe('sess-456');
    });
  });

  describe('validation', () => {
    it('rejects invalid response format', () => {
      const result = handler.handleResponse({} as any);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('handles unknown actionId gracefully', () => {
      const result = handler.handleResponse(
        makeResponse({ actionId: 'nonexistent', status: 'completed' }),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('nonexistent');
    });
  });
});
