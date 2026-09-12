import { describe, it, expect } from 'vitest';
import { Orchestrator, DEFAULT_TASK_PRIORITY, DEFAULT_WORKER_TASK_PRIORITY } from '../orchestrator.js';
import { InMemoryPersistence, InMemoryBus } from './helpers/cross-workflow-cascade-helpers.js';

describe('task config priority defaults', () => {
  it('defaults an unset task priority to the human baseline', () => {
    const orchestrator = new Orchestrator({
      persistence: new InMemoryPersistence(),
      messageBus: new InMemoryBus(),
      maxConcurrency: 2,
    });

    orchestrator.loadPlan({
      name: 'no-priority-plan',
      baseBranch: 'master',
      featureBranch: 'feature/no-priority',
      tasks: [{ id: 'a', description: 'A' }],
    });

    const task = orchestrator.getAllTasks().find((t) => !t.config.isMergeNode);
    expect(task?.config.priority).toBe(DEFAULT_TASK_PRIORITY);
    expect(DEFAULT_TASK_PRIORITY).toBe(2);
  });

  it('keeps an explicit worker-style priority instead of the human default', () => {
    const orchestrator = new Orchestrator({
      persistence: new InMemoryPersistence(),
      messageBus: new InMemoryBus(),
      maxConcurrency: 2,
    });

    orchestrator.loadPlan({
      name: 'worker-priority-plan',
      baseBranch: 'master',
      featureBranch: 'feature/worker-priority',
      tasks: [{ id: 'a', description: 'A', priority: DEFAULT_WORKER_TASK_PRIORITY }],
    });

    const task = orchestrator.getAllTasks().find((t) => !t.config.isMergeNode);
    expect(task?.config.priority).toBe(DEFAULT_WORKER_TASK_PRIORITY);
    expect(DEFAULT_WORKER_TASK_PRIORITY).toBe(4);
  });
});
