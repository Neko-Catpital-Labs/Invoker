import { beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '@invoker/contracts';
import {
  Orchestrator,
  type OrchestratorMessageBus,
  type PlanDefinition,
} from '@invoker/workflow-core';
import { InMemoryPersistence } from '@invoker/test-kit';
import { relaunchOrphansAndStartReady } from '../orphan-relaunch.js';

class InMemoryBus implements OrchestratorMessageBus {
  publish(): void {}
}

const testLogger = { info: () => {} } as Logger;

function taskIdBySuffix(orchestrator: Orchestrator, suffix: string): string {
  const task = orchestrator.getAllTasks().find((entry) => entry.id.endsWith(`/${suffix}`));
  if (!task) throw new Error(`task not found: ${suffix}`);
  return task.id;
}

describe('relaunchOrphansAndStartReady', () => {
  let persistence: InMemoryPersistence;

  const oneTaskPlan: PlanDefinition = {
    name: 'orphan-relaunch',
    onFinish: 'none',
    tasks: [{ id: 'task-claimed', description: 'task', command: 'echo task' }],
  };

  beforeEach(() => {
    persistence = new InMemoryPersistence();
  });

  function buildOrchestratorWithDispatcher(): Orchestrator {
    return new Orchestrator({
      persistence,
      messageBus: new InMemoryBus(),
      taskDispatcher: () => {},
    });
  }

  it('relaunches running orphans', () => {
    const orchestrator = buildOrchestratorWithDispatcher();
    orchestrator.loadPlan(oneTaskPlan);
    const workflowId = orchestrator.getWorkflowIds()[0]!;
    const taskId = taskIdBySuffix(orchestrator, 'task-claimed');
    orchestrator.startExecution();

    const resumed = buildOrchestratorWithDispatcher();
    resumed.syncFromDb(workflowId);
    relaunchOrphansAndStartReady(resumed, testLogger, 'test');
    expect(resumed.getTask(taskId)?.status).toBe('running');
  });

  it('relaunches fixing_with_ai orphans', () => {
    const orchestrator = buildOrchestratorWithDispatcher();
    orchestrator.loadPlan(oneTaskPlan);
    const workflowId = orchestrator.getWorkflowIds()[0]!;
    const taskId = taskIdBySuffix(orchestrator, 'task-claimed');
    orchestrator.startExecution();
    persistence.updateTask(taskId, {
      status: 'fixing_with_ai',
      execution: { isFixingWithAI: true },
    });
    orchestrator.syncAllFromDb();

    const resumed = buildOrchestratorWithDispatcher();
    resumed.syncFromDb(workflowId);
    relaunchOrphansAndStartReady(resumed, testLogger, 'test');
    expect(resumed.getTask(taskId)?.status).toBe('running');
  });

  it('relaunches pending task with persisted claimed attempt', () => {
    const orchestrator = buildOrchestratorWithDispatcher();
    orchestrator.loadPlan(oneTaskPlan);
    const workflowId = orchestrator.getWorkflowIds()[0]!;
    const taskId = taskIdBySuffix(orchestrator, 'task-claimed');
    orchestrator.startExecution();
    persistence.updateTask(taskId, { status: 'pending' });
    orchestrator.syncAllFromDb();

    const resumed = buildOrchestratorWithDispatcher();
    resumed.syncFromDb(workflowId);
    relaunchOrphansAndStartReady(resumed, testLogger, 'test');
    expect(resumed.getTask(taskId)?.status).toBe('running');
  });
});
