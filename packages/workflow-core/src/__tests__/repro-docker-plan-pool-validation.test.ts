import { describe, expect, it } from 'vitest';
import { parsePlan, PlanParseError } from '../plan-parser.js';
import { Orchestrator } from '../orchestrator.js';
import {
  InMemoryBus,
  InMemoryPersistence,
} from './helpers/cross-workflow-cascade-helpers.js';

describe('Docker plan-level pool validation', () => {
  it('rejects a plan-level pool when the task is Docker-routed', () => {
    const yaml = `
name: Docker plan pool
repoUrl: git@github.com:example/repo.git
poolId: ssh-pool
tasks:
  - id: docker-task
    description: Run in Docker
    command: echo ok
    dockerImage: node:20
`;

    expect(() => parsePlan(yaml)).toThrow(PlanParseError);
    expect(() => parsePlan(yaml)).toThrow(/dockerImage.*poolId|poolId.*dockerImage/);
  });

  it('does not let the configured default pool override Docker routing', () => {
    const persistence = new InMemoryPersistence();
    const orchestrator = new Orchestrator({
      persistence,
      messageBus: new InMemoryBus(),
      defaultPoolId: 'local-worktree',
      availablePoolIds: ['local-worktree'],
    });

    orchestrator.loadPlan({
      name: 'Docker default pool',
      onFinish: 'none',
      tasks: [{
        id: 'docker-task',
        description: 'Run in Docker',
        command: 'echo ok',
        dockerImage: 'node:20',
      }],
    });

    const task = orchestrator.getAllTasks().find((candidate) => !candidate.config.isMergeNode);
    expect(task?.config.runnerKind).toBe('docker');
    expect(task?.config.poolId).toBeUndefined();
    expect(persistence.events).toContainEqual({
      taskId: task?.id,
      eventType: 'task.executor.routed',
      payload: {
        runnerKind: 'docker',
        reason: { type: 'dockerImage' },
      },
    });
  });
});
