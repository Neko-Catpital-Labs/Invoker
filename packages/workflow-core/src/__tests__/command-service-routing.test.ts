import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommandService } from '../command-service.js';
import type {
  InvalidationDeps,
  InvalidationScope,
  InvalidationAction,
} from '../invalidation-policy.js';
import type { Orchestrator } from '../orchestrator.js';
import type { CommandEnvelope } from '@invoker/contracts';
import type { TaskState } from '@invoker/workflow-graph';

function makeEnvelope<P>(payload: P, id = 'cmd-1'): CommandEnvelope<P> {
  return {
    commandId: id,
    source: 'headless',
    scope: 'task',
    idempotencyKey: `key-${id}`,
    payload,
  };
}

// Fixed `createdAt` so two separate `makeTask()` calls produce
// deeply-equal results — needed for `toEqual` against the orchestrator
// fallback's return value.
const FIXED_CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

function makeTask(): TaskState {
  return {
    id: 'task-1',
    description: 'task',
    dependencies: [],
    status: 'pending',
    createdAt: FIXED_CREATED_AT,
    config: { workflowId: 'wf-1', isMergeNode: false },
    execution: {},
  } as unknown as TaskState;
}

function makeOrchestrator(): Orchestrator {
  return {
    getTask: vi.fn(() => makeTask()),
    cancelTask: vi.fn(() => ({ cancelled: [], runningCancelled: [] })),
    cancelWorkflow: vi.fn(() => ({ cancelled: [], runningCancelled: [] })),
    retryTask: vi.fn(() => [makeTask()]),
    recreateTask: vi.fn(() => [makeTask()]),
    retryWorkflow: vi.fn(() => [makeTask()]),
    recreateWorkflow: vi.fn(() => [makeTask()]),
    recreateWorkflowFromFreshBase: vi.fn(async () => [makeTask()]),
    forkWorkflow: vi.fn(() => ({ started: [] })),
    cascadeInvalidationToDownstream: vi.fn(() => []),
    autoStartExternallyUnblockedReadyTasks: vi.fn(() => []),
    approve: vi.fn(async () => []),
    reject: vi.fn(),
  } as unknown as Orchestrator;
}

function makeSpiedDeps(): {
  deps: InvalidationDeps;
  events: Array<{ stage: string; scope?: InvalidationScope; id: string }>;
} {
  const events: Array<{ stage: string; scope?: InvalidationScope; id: string }> = [];
  const result: TaskState[] = [];
  const deps: InvalidationDeps = {
    cancelInFlight: vi.fn(async (scope, id) => {
      events.push({ stage: 'cancelInFlight', scope, id });
    }),
    retryTask: vi.fn((id) => {
      events.push({ stage: 'retryTask', id });
      return result;
    }),
    recreateTask: vi.fn((id) => {
      events.push({ stage: 'recreateTask', id });
      return result;
    }),
    retryWorkflow: vi.fn((id) => {
      events.push({ stage: 'retryWorkflow', id });
      return result;
    }),
    recreateWorkflow: vi.fn((id) => {
      events.push({ stage: 'recreateWorkflow', id });
      return result;
    }),
    recreateWorkflowFromFreshBase: vi.fn(async (id) => {
      events.push({ stage: 'recreateWorkflowFromFreshBase', id });
      return result;
    }),
    cascadeDownstream: vi.fn((scope, id) => {
      events.push({ stage: 'cascadeDownstream', scope, id });
      return [];
    }),
  };
  return { deps, events };
}

describe('CommandService → applyInvalidation routing', () => {
  let orchestrator: Orchestrator;

  beforeEach(() => {
    orchestrator = makeOrchestrator();
  });

  type RoutedCase = {
    method: 'retryTask' | 'recreateTask' | 'retryWorkflow' | 'recreateWorkflow' | 'recreateWorkflowFromFreshBase';
    scope: InvalidationScope;
    action: InvalidationAction;
    id: string;
    invoke: (cs: CommandService) => Promise<unknown>;
  };

  const routedCases: RoutedCase[] = [
    {
      method: 'retryTask',
      scope: 'task',
      action: 'retryTask',
      id: 'task-1',
      invoke: (cs) => cs.retryTask(makeEnvelope({ taskId: 'task-1' }, 'r-task')),
    },
    {
      method: 'recreateTask',
      scope: 'task',
      action: 'recreateTask',
      id: 'task-1',
      invoke: (cs) => cs.recreateTask(makeEnvelope({ taskId: 'task-1' }, 'rc-task')),
    },
    {
      method: 'retryWorkflow',
      scope: 'workflow',
      action: 'retryWorkflow',
      id: 'wf-1',
      invoke: (cs) => cs.retryWorkflow(makeEnvelope({ workflowId: 'wf-1' }, 'r-wf')),
    },
    {
      method: 'recreateWorkflow',
      scope: 'workflow',
      action: 'recreateWorkflow',
      id: 'wf-1',
      invoke: (cs) => cs.recreateWorkflow(makeEnvelope({ workflowId: 'wf-1' }, 'rc-wf')),
    },
    {
      method: 'recreateWorkflowFromFreshBase',
      scope: 'workflow',
      action: 'recreateWorkflowFromFreshBase',
      id: 'wf-1',
      invoke: (cs) =>
        cs.recreateWorkflowFromFreshBase(
          makeEnvelope({ workflowId: 'wf-1' }, 'rcffb-wf'),
        ),
    },
  ];

  for (const c of routedCases) {
    it(`${c.method}: routes through applyInvalidation('${c.scope}', '${c.action}', '${c.id}', injectedDeps)`, async () => {
      const { deps, events } = makeSpiedDeps();
      const cs = new CommandService(orchestrator, deps);

      const result = await c.invoke(cs);

      expect(result).toEqual({ ok: true, data: [] });

      const stages = events.map((e) => e.stage);
      expect(stages).toEqual(['cancelInFlight', c.action, 'cascadeDownstream']);

      const cancel = events[0];
      const dispatch = events[1];
      const cascade = events[2];
      expect(cancel.scope).toBe(c.scope);
      expect(cancel.id).toBe(c.id);
      expect(dispatch.id).toBe(c.id);
      expect(cascade.scope).toBe(c.scope);
      expect(cascade.id).toBe(c.id);

      expect(orchestrator.cancelTask).not.toHaveBeenCalled();
      expect(orchestrator.cancelWorkflow).not.toHaveBeenCalled();
      expect(orchestrator.cascadeInvalidationToDownstream).not.toHaveBeenCalled();
    });
  }

  it('falls back to orchestrator-only deps when none are injected', async () => {
    const cs = new CommandService(orchestrator);

    const result = await cs.retryTask(makeEnvelope({ taskId: 'task-1' }));

    expect(result).toEqual({ ok: true, data: [makeTask()] });
    expect(orchestrator.cancelTask).toHaveBeenCalledWith('task-1');
    expect(orchestrator.retryTask).toHaveBeenCalledWith('task-1');
    expect(orchestrator.cascadeInvalidationToDownstream).toHaveBeenCalledWith('wf-1');
  });
});
