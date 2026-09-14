import { describe, expect, it } from 'vitest';
import {
  InMemoryPersistence,
  makeOrchestrator,
  makeResponse,
} from './helpers/cross-workflow-cascade-helpers.js';

describe('failed task cascade', () => {
  it('skips never-started dependents but leaves reconciliation dependents untouched and retry resurrects them', () => {
    const persistence = new InMemoryPersistence();
    const orchestrator = makeOrchestrator(persistence);

    orchestrator.loadPlan({
      name: 'fail-cascade',
      baseBranch: 'master',
      featureBranch: 'feature/fail-cascade',
      tasks: [
        { id: 'a', description: 'A' },
        { id: 'b', description: 'B', dependencies: ['a'] },
        { id: 'c', description: 'C', dependencies: ['b'] },
        { id: 'd', description: 'D', dependencies: ['a'] },
      ],
    });

    const a = orchestrator.getAllTasks().find((task) => task.id.endsWith('/a'))!;
    const b = orchestrator.getTask(`${a.config.workflowId}/b`)!;
    const c = orchestrator.getTask(`${a.config.workflowId}/c`)!;
    const d = orchestrator.getTask(`${a.config.workflowId}/d`)!;
    orchestrator.startExecution();
    Object.assign(d.config, { isReconciliation: true });

    expect(orchestrator.getTask(a.id)!.status).toBe('running');
    expect(orchestrator.getTask(b.id)!.status).toBe('pending');
    expect(orchestrator.getTask(c.id)!.status).toBe('pending');
    expect(orchestrator.getTask(d.id)!.status).toBe('pending');

    orchestrator.handleWorkerResponse(makeResponse({
      actionId: a.id,
      status: 'failed',
      outputs: { exitCode: 1, error: 'boom' },
    }));

    expect(orchestrator.getTask(b.id)!.status).toBe('skipped');
    expect(orchestrator.getTask(c.id)!.status).toBe('skipped');
    expect(orchestrator.getTask(b.id)!.execution.blockedBy).toContain('task "a" failed');
    expect(orchestrator.getTask(c.id)!.execution.blockedBy).toContain('task "a" failed');
    expect(orchestrator.getTask(d.id)!.status).not.toBe('skipped');
    expect([b.id, c.id].map((id) => orchestrator.getTask(id)!.status).filter((status) =>
      status === 'running' || status === 'queued',
    )).toEqual([]);

    orchestrator.retryTask(a.id);

    expect(orchestrator.getTask(b.id)!.status).toBe('pending');
    expect(orchestrator.getTask(c.id)!.status).toBe('pending');
    expect(orchestrator.getTask(b.id)!.execution.blockedBy).toBeUndefined();
    expect(orchestrator.getTask(c.id)!.execution.blockedBy).toBeUndefined();
  });
});
