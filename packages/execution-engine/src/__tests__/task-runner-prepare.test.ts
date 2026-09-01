import { describe, expect, it, vi } from 'vitest';
import { Orchestrator, parsePlan } from '@invoker/workflow-core';
import type { TaskFreshnessSpec, TaskState } from '@invoker/workflow-core';
import { SQLiteAdapter } from '@invoker/data-store';
import { buildWorkRequest } from '../task-runner-prepare.js';
import type { TaskRunnerPhaseHost } from '../task-runner-phase-host.js';

function makeTask(freshness?: TaskFreshnessSpec): TaskState {
  return {
    id: 'wf-1/task-1',
    description: 'Transport the typed contract',
    status: 'pending',
    dependencies: [],
    createdAt: new Date('2026-08-31T00:00:00.000Z'),
    config: {
      workflowId: 'wf-1',
      command: 'echo ok',
      freshness,
    },
    execution: { generation: 0 },
    taskStateVersion: 1,
  };
}

function makeHost(): TaskRunnerPhaseHost {
  return {
    buildUpstreamContext: vi.fn().mockResolvedValue([]),
    collectUpstreamBranches: vi.fn().mockReturnValue([]),
    collectUpstreamBase: vi.fn().mockReturnValue(undefined),
    buildAlternatives: vi.fn().mockReturnValue([]),
    orchestrator: { getTask: vi.fn() },
    resolveExternalDependencyTask: vi.fn(),
    persistence: {
      loadWorkflow: vi.fn().mockReturnValue({
        id: 'wf-1',
        baseBranch: 'main',
        repoUrl: 'git@github.com:test/repo.git',
      }),
      loadAttempt: vi.fn().mockReturnValue(undefined),
    },
    freshBaseCommits: new Map(),
    defaultBranch: 'main',
    shouldUseFreshWorkspace: vi.fn().mockReturnValue(false),
    determineActionType: vi.fn().mockReturnValue('command'),
    resolveExecutionAgent: vi.fn().mockReturnValue(undefined),
    resolveExecutionModel: vi.fn().mockReturnValue(undefined),
    isLaunchStale: vi.fn().mockReturnValue(false),
  } as unknown as TaskRunnerPhaseHost;
}

describe('buildWorkRequest task freshness transport', () => {
  it('round-trips task freshness from plan YAML through SQLite into WorkRequestInputs', async () => {
    const persistence = await SQLiteAdapter.create(':memory:');
    try {
      const orchestrator = new Orchestrator({
        persistence,
        messageBus: { publish: vi.fn() },
      });
      orchestrator.loadPlan(parsePlan(`
name: Freshness Integration
repoUrl: git@github.com:test/repo.git
tasks:
  - id: work
    description: Do work
    command: echo ok
    freshness:
      watchPaths: [packages/z.ts, packages/a.ts]
      pathPreconditions:
        - path: packages/a.ts
          expected: present
        - path: generated/output.json
          expected: absent
      guardedBehaviorIds: [z_guard, a-guard]
  - id: legacy
    description: Legacy work
    command: echo legacy
`));

      const task = orchestrator.getAllTasks().find((candidate) => !candidate.config.isMergeNode);
      expect(task).toBeDefined();
      const request = await buildWorkRequest({
        ...makeHost(),
        orchestrator,
        persistence,
      } as TaskRunnerPhaseHost, {
        task: task!,
        attemptId: `${task!.id}-a12345678`,
        bench: vi.fn(),
      });

      expect(request.inputs.freshness).toEqual({
        watchPaths: ['packages/a.ts', 'packages/z.ts'],
        pathPreconditions: [
          { path: 'generated/output.json', expected: 'absent' },
          { path: 'packages/a.ts', expected: 'present' },
        ],
        guardedBehaviorIds: ['a-guard', 'z_guard'],
      });

      const legacyTask = orchestrator.getAllTasks().find((candidate) => candidate.id.endsWith('/legacy'));
      expect(legacyTask).toBeDefined();
      expect(legacyTask!.config).not.toHaveProperty('freshness');
      const legacyRequest = await buildWorkRequest({
        ...makeHost(),
        orchestrator,
        persistence,
      } as TaskRunnerPhaseHost, {
        task: legacyTask!,
        attemptId: `${legacyTask!.id}-a12345678`,
        bench: vi.fn(),
      });
      expect(legacyRequest.inputs).not.toHaveProperty('freshness');
    } finally {
      persistence.close();
    }
  });

  it('transports normalized task freshness unchanged', async () => {
    const freshness: TaskFreshnessSpec = {
      watchPaths: ['packages/a.ts', 'packages/z.ts'],
      pathPreconditions: [
        { path: 'generated/output.json', expected: 'absent' },
        { path: 'packages/a.ts', expected: 'present' },
      ],
      guardedBehaviorIds: ['a-guard', 'z_guard'],
    };

    const request = await buildWorkRequest(makeHost(), {
      task: makeTask(freshness),
      attemptId: 'wf-1/task-1-a12345678',
      bench: vi.fn(),
    });

    expect(request.inputs.freshness).toBe(freshness);
    expect(request.inputs.freshness).toEqual(freshness);
  });

  it('keeps omitted task freshness omitted', async () => {
    const request = await buildWorkRequest(makeHost(), {
      task: makeTask(),
      attemptId: 'wf-1/task-1-a12345678',
      bench: vi.fn(),
    });

    expect(request.inputs).not.toHaveProperty('freshness');
  });
});
