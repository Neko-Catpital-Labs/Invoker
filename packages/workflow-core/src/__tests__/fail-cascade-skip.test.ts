import { describe, expect, it } from 'vitest';
import { createTaskState } from '@invoker/workflow-graph';
import { InMemoryPersistence, makeOrchestrator, makeResponse } from './helpers/cross-workflow-cascade-helpers.js';

describe('failed task skip cascade', () => {
  it('skips never-started dependents but leaves reconciliation dependents untouched, then resurrects them on retry', () => {
    const persistence = new InMemoryPersistence();
    const orchestrator = makeOrchestrator(persistence);

    orchestrator.loadPlan({
      name: 'skip-cascade',
      baseBranch: 'master',
      featureBranch: 'feature/skip-cascade',
      tasks: [
        { id: 'A', description: 'A' },
        { id: 'B', description: 'B', dependencies: ['A'] },
        { id: 'C', description: 'C', dependencies: ['B'] },
      ],
    });

    const aId = orchestrator.getAllTasks().find((task) => task.id.endsWith('/A'))!.id;
    const bId = `${aId.slice(0, aId.lastIndexOf('/'))}/B`;
    const cId = `${aId.slice(0, aId.lastIndexOf('/'))}/C`;
    const dId = `${aId.slice(0, aId.lastIndexOf('/'))}/D`;
    const workflowId = aId.slice(0, aId.lastIndexOf('/'));
    const reconciliation = createTaskState(
      dId,
      'D reconciliation task',
      [aId, bId],
      { workflowId, isReconciliation: true },
    );
    persistence.saveTask(workflowId, reconciliation);
    (orchestrator as unknown as { stateMachine: { restoreTask: (task: typeof reconciliation) => void } })
      .stateMachine.restoreTask(reconciliation);

    orchestrator.startExecution();
    expect(orchestrator.getTask(aId)!.status).toBe('running');
    expect(orchestrator.getTask(bId)!.status).toBe('pending');
    expect(orchestrator.getTask(cId)!.status).toBe('pending');
    expect(orchestrator.getTask(dId)!.status).toBe('pending');

    orchestrator.handleWorkerResponse(makeResponse({
      actionId: aId,
      status: 'failed',
      outputs: { exitCode: 1, error: 'A failed' },
    }));

    for (const id of [bId, cId]) {
      const task = orchestrator.getTask(id)!;
      expect(task.status).toBe('skipped');
      expect(task.execution.blockedBy).toBe('upstream task "A" failed');
      expect(['pending', 'queued', 'running', 'fixing_with_ai', 'blocked']).not.toContain(task.status);
    }
    expect(orchestrator.getTask(dId)!.status).toBe('pending');
    expect(orchestrator.getTask(dId)!.execution.blockedBy).toBeUndefined();

    orchestrator.retryTask(aId);

    for (const id of [bId, cId]) {
      const task = orchestrator.getTask(id)!;
      expect(task.status).toBe('pending');
      expect(task.execution.blockedBy).toBeUndefined();
    }
  });
});
