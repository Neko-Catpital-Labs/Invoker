import { describe, expect, it, vi } from 'vitest';

import { BUILTIN_WORKER_KINDS } from '../builtin-worker-kinds.js';
import { registerBuiltinWorkers } from '../builtin-workers.js';
import { createWorkerRegistry } from '../worker-registry.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import {
  kindsWithDecisionFixtures,
  loadDecisionFixtures,
  loadDecisionFixturesForKind,
} from '../workers/decision-fixtures/load.js';
import {
  createRequeueRecoveryTick,
  REQUEUE_COMMAND_CHANNEL,
  parseRequeueMutationArgs,
} from '../workers/requeue-worker.js';
import { createRequeueAttemptLedger } from '../requeue-attempt-ledger.js';
import { planIdleTaskCleanup } from '../workers/idle-task-cleanup-worker.js';
import type { TaskState, TaskStatus } from '@invoker/workflow-core';

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
};

describe('worker decision fixtures', () => {
  it('covers every built-in worker kind with at least one fixture', () => {
    const covered = new Set(kindsWithDecisionFixtures());
    const missing = BUILTIN_WORKER_KINDS.filter((kind) => !covered.has(kind));
    expect(missing).toEqual([]);
  });

  it('every fixture has a kind, name, and decisions array', () => {
    for (const fixture of loadDecisionFixtures()) {
      expect(fixture.kind.length).toBeGreaterThan(0);
      expect(fixture.name.length).toBeGreaterThan(0);
      expect(fixture.decisions.length).toBeGreaterThan(0);
      for (const decision of fixture.decisions) {
        expect(['skip', 'mutation', 'effect']).toContain(decision.type);
      }
    }
  });

  it('registerBuiltinWorkers kinds match BUILTIN_WORKER_KINDS', () => {
    const registry = registerBuiltinWorkers(createWorkerRegistry<WorkerRuntimeDependencies>());
    expect(registry.list().map((d) => d.kind)).toEqual([...BUILTIN_WORKER_KINDS]);
  });

  it('heartbeat-requeue stalled-task-requeue matches the live tick', async () => {
    const fixture = loadDecisionFixturesForKind('heartbeat-requeue').find(
      (row) => row.name === 'stalled-task-requeue',
    );
    expect(fixture).toBeDefined();
    const task: TaskState = {
      id: 'wf-1/gate',
      description: 'stalled merge gate',
      status: 'failed',
      dependencies: [],
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      config: { workflowId: 'wf-1', isMergeNode: true },
      execution: {
        error: 'Execution stalled: ... (attempt lease expired).',
        failureClass: 'liveness_stall',
        generation: 2,
        selectedAttemptId: 'attempt-1',
      },
      taskStateVersion: 3,
    };
    const intents: Array<{ channel: string; args: unknown[]; workflowId: string }> = [];
    const submit = vi.fn((workflowId: string, _priority: string, channel: string, args: unknown[]) => {
      intents.push({ workflowId, channel, args });
      return intents.length;
    });
    const tick = createRequeueRecoveryTick({
      store: {
        listWorkflows: () => [{ id: 'wf-1' }],
        loadTasks: () => [task],
        loadTask: (id: string) => (id === task.id ? task : undefined),
        listWorkflowMutationIntents: () => [],
      },
      submitter: { submit },
      logger: silentLogger,
      ledger: createRequeueAttemptLedger(),
      stallRequeueRetries: 3,
      stallRequeueBackoffMs: 120_000,
      now: () => 0,
    });
    await tick({
      identity: { kind: 'heartbeat-requeue', instanceId: 'r1' },
      reason: 'poll',
      tickNumber: 1,
      signal: new AbortController().signal,
    });
    expect(intents).toHaveLength(1);
    expect(intents[0].channel).toBe(REQUEUE_COMMAND_CHANNEL);
    expect(parseRequeueMutationArgs(intents[0].args)).toEqual({ taskId: 'wf-1/gate' });
    const expected = fixture!.decisions[0];
    expect(expected.type).toBe('mutation');
    if (expected.type === 'mutation') {
      expect(intents[0].workflowId).toBe(expected.workflowId);
      expect(intents[0].channel).toBe(expected.channel);
      expect(intents[0].args).toEqual(expected.args);
    }
  });

  it('heartbeat-requeue non-liveness-skip matches the live tick', async () => {
    const fixture = loadDecisionFixturesForKind('heartbeat-requeue').find(
      (row) => row.name === 'non-liveness-skip',
    );
    expect(fixture).toBeDefined();
    const task: TaskState = {
      id: 'wf-1/gate',
      description: 'code failure',
      status: 'failed',
      dependencies: [],
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      config: { workflowId: 'wf-1' },
      execution: { error: 'real bug', generation: 2 },
      taskStateVersion: 3,
    };
    const submit = vi.fn();
    const tick = createRequeueRecoveryTick({
      store: {
        listWorkflows: () => [{ id: 'wf-1' }],
        loadTasks: () => [task],
        loadTask: (id: string) => (id === task.id ? task : undefined),
        listWorkflowMutationIntents: () => [],
      },
      submitter: { submit },
      logger: silentLogger,
      ledger: createRequeueAttemptLedger(),
      now: () => 0,
    });
    await tick({
      identity: { kind: 'heartbeat-requeue', instanceId: 'r1' },
      reason: 'poll',
      tickNumber: 1,
      signal: new AbortController().signal,
    });
    expect(submit).not.toHaveBeenCalled();
    expect(fixture!.decisions).toEqual([{ type: 'skip', reason: 'not-requeueable-failure' }]);
  });

  it('idle-task-cleanup retire-completed-workflow matches planIdleTaskCleanup', () => {
    const fixture = loadDecisionFixturesForKind('idle-task-cleanup').find(
      (row) => row.name === 'retire-completed-workflow',
    );
    expect(fixture).toBeDefined();
    const state = fixture!.state as {
      workflows: Array<{ id: string; name: string; status: string; updatedAt: string }>;
      tasksByWorkflow: Record<string, Array<{ id: string; status: TaskStatus }>>;
      nowMs: number;
    };
    const plan = planIdleTaskCleanup(
      state.workflows,
      (id) =>
        (state.tasksByWorkflow[id] ?? []).map(
          (row) =>
            ({
              id: row.id,
              description: row.id,
              status: row.status,
              dependencies: [],
              createdAt: new Date(state.nowMs - 60 * 60_000),
              config: { workflowId: id },
              execution: { generation: 0 },
              taskStateVersion: 1,
            }) as TaskState,
        ),
      { now: state.nowMs },
    );
    expect(plan).toEqual([
      { kind: 'delete-workflow', workflowId: 'wf-completed', reason: 'workflow completed' },
    ]);
    const expected = fixture!.decisions[0];
    expect(expected.type).toBe('mutation');
    if (expected.type === 'mutation') {
      expect(expected.workflowId).toBe('wf-completed');
      expect(expected.channel).toBe('invoker:delete-workflow');
      expect(expected.args).toEqual(['wf-completed']);
    }
  });
});
