import { describe, expect, it } from 'vitest';
import type { Attempt, TaskState } from '@invoker/workflow-core';
import type { TaskEvent, TaskLaunchDispatch, Workflow } from '@invoker/data-store';
import {
  buildActionGraphDiagnostics,
  resolveActionDiagnosticsStallThresholdMs,
} from '../action-graph-diagnostics.js';

const now = new Date('2026-05-14T12:00:00.000Z');

function task(overrides: Partial<TaskState> & { id: string }): TaskState {
  return {
    id: overrides.id,
    description: overrides.description ?? overrides.id,
    status: overrides.status ?? 'pending',
    dependencies: overrides.dependencies ?? [],
    createdAt: overrides.createdAt ?? new Date('2026-05-14T11:45:00.000Z'),
    config: { workflowId: 'wf-1', ...(overrides.config ?? {}) },
    execution: { generation: 0, ...(overrides.execution ?? {}) },
    taskStateVersion: 1,
  };
}

function attempt(overrides: Partial<Attempt> & { id: string; nodeId: string }): Attempt {
  return {
    id: overrides.id,
    nodeId: overrides.nodeId,
    queuePriority: overrides.queuePriority ?? 0,
    status: overrides.status ?? 'pending',
    upstreamAttemptIds: overrides.upstreamAttemptIds ?? [],
    createdAt: overrides.createdAt ?? new Date('2026-05-14T11:40:00.000Z'),
    ...overrides,
  };
}

const workflow: Workflow = {
  id: 'wf-1',
  name: 'Workflow One',
  status: 'running',
  createdAt: '2026-05-14T11:30:00.000Z',
  updatedAt: '2026-05-14T11:50:00.000Z',
};

describe('buildActionGraphDiagnostics', () => {
  it('creates queued mutation action nodes with queue duration', () => {
    const graph = buildActionGraphDiagnostics({
      workflows: [workflow],
      tasks: [],
      attemptsByTaskId: new Map(),
      queueStatus: { maxConcurrency: 1, runningCount: 0, running: [], queued: [] },
      mutationIntents: [{
        id: 7,
        workflowId: 'wf-1',
        channel: 'invoker:retry-workflow',
        args: ['wf-1'],
        priority: 'high',
        status: 'queued',
        createdAt: '2026-05-14T11:55:00.000Z',
      }],
      mutationLeases: [],
      eventsByTaskId: new Map(),
      activityLogs: [],
      stallThresholdMs: 60_000,
      now,
    });

    const intent = graph.nodes.find((node) => node.id === 'intent:7');
    expect(intent?.type).toBe('mutation-intent');
    expect(intent?.status).toBe('queued');
    expect(intent?.durations?.queuedMs).toBe(5 * 60_000);
    expect(graph.edges).toContainEqual(expect.objectContaining({ source: 'action:wf-1', target: 'intent:7' }));
  });

  it('creates running mutation action nodes with deterministic running duration', () => {
    const graph = buildActionGraphDiagnostics({
      workflows: [workflow],
      tasks: [],
      attemptsByTaskId: new Map(),
      queueStatus: { maxConcurrency: 1, runningCount: 0, running: [], queued: [] },
      mutationIntents: [{
        id: 8,
        workflowId: 'wf-1',
        channel: 'invoker:rebase-recreate',
        args: ['wf-1'],
        priority: 'high',
        status: 'running',
        createdAt: '2026-05-14T11:55:00.000Z',
        startedAt: '2026-05-14T11:58:00.000Z',
        ownerId: 'owner-1',
      }],
      mutationLeases: [],
      eventsByTaskId: new Map(),
      activityLogs: [],
      stallThresholdMs: 60_000,
      now,
    });

    const intent = graph.nodes.find((node) => node.id === 'intent:8');
    expect(intent).toEqual(expect.objectContaining({
      type: 'mutation-intent',
      status: 'running',
      label: 'invoker:rebase-recreate',
      ownerId: 'owner-1',
    }));
    expect(intent?.durations?.runningMs).toBe(120_000);
  });

  it('marks expired mutation leases as stalled with heartbeat age', () => {
    const graph = buildActionGraphDiagnostics({
      workflows: [workflow],
      tasks: [],
      attemptsByTaskId: new Map(),
      queueStatus: { maxConcurrency: 1, runningCount: 0, running: [], queued: [] },
      mutationIntents: [],
      mutationLeases: [{
        workflowId: 'wf-1',
        ownerId: 'owner',
        activeIntentId: 2,
        activeMutationKind: 'invoker:recreate-workflow',
        leasedAt: '2026-05-14T11:57:00.000Z',
        lastHeartbeatAt: '2026-05-14T11:58:00.000Z',
        leaseExpiresAt: '2026-05-14T11:59:00.000Z',
      }],
      eventsByTaskId: new Map(),
      activityLogs: [],
      stallThresholdMs: 60_000,
      now,
    });

    const lease = graph.nodes.find((node) => node.id === 'lease:wf-1');
    expect(lease?.status).toBe('stalled');
    expect(lease?.durations?.heartbeatAgeMs).toBe(2 * 60_000);
  });

  it('shows unaccepted launch dispatches as queued diagnostic nodes', () => {
    const graph = buildActionGraphDiagnostics({
      workflows: [workflow],
      tasks: [task({ id: 'task-a', execution: { selectedAttemptId: 'attempt-a1' } })],
      attemptsByTaskId: new Map([
        ['task-a', [attempt({ id: 'attempt-a1', nodeId: 'task-a' })]],
      ]),
      queueStatus: { maxConcurrency: 1, runningCount: 0, running: [], queued: [] },
      mutationIntents: [],
      mutationLeases: [],
      launchDispatches: [{
        id: 42,
        taskId: 'task-a',
        attemptId: 'attempt-a1',
        workflowId: 'wf-1',
        state: 'enqueued',
        priority: 'high',
        enqueuedAt: '2026-05-14T11:56:00.000Z',
        attemptsCount: 0,
        generation: 3,
      } satisfies TaskLaunchDispatch],
      eventsByTaskId: new Map(),
      activityLogs: [],
      stallThresholdMs: 60_000,
      now,
    });

    const dispatch = graph.nodes.find((node) => node.id === 'launch-dispatch:42');
    expect(dispatch).toEqual(expect.objectContaining({
      type: 'launch-dispatch',
      status: 'queued',
      taskId: 'task-a',
      suggestedNextAction: 'The task is queued for launch, but no owner has accepted it yet.',
    }));
    expect(dispatch?.durations?.queuedMs).toBe(4 * 60_000);
    expect(graph.edges).toContainEqual(expect.objectContaining({
      source: 'launch-dispatch:42',
      target: 'attempt:attempt-a1',
      label: 'launch',
    }));
  });

  it('shows leased launch dispatches as running diagnostic nodes', () => {
    const graph = buildActionGraphDiagnostics({
      workflows: [workflow],
      tasks: [task({ id: 'task-a', execution: { selectedAttemptId: 'attempt-a1' } })],
      attemptsByTaskId: new Map([
        ['task-a', [attempt({ id: 'attempt-a1', nodeId: 'task-a' })]],
      ]),
      queueStatus: { maxConcurrency: 1, runningCount: 0, running: [], queued: [] },
      mutationIntents: [],
      mutationLeases: [],
      launchDispatches: [{
        id: 43,
        taskId: 'task-a',
        attemptId: 'attempt-a1',
        workflowId: 'wf-1',
        state: 'leased',
        priority: 'high',
        enqueuedAt: '2026-05-14T11:56:00.000Z',
        leasedAt: '2026-05-14T11:59:00.000Z',
        fencedUntil: '2026-05-14T12:19:00.000Z',
        attemptsCount: 1,
        generation: 3,
        dispatchOwner: 'owner-1',
      } satisfies TaskLaunchDispatch],
      eventsByTaskId: new Map(),
      activityLogs: [],
      stallThresholdMs: 60_000,
      now,
    });

    const dispatch = graph.nodes.find((node) => node.id === 'launch-dispatch:43');
    expect(dispatch).toEqual(expect.objectContaining({
      type: 'launch-dispatch',
      status: 'running',
      ownerId: 'owner-1',
    }));
    expect(dispatch?.durations?.runningMs).toBe(60_000);
    expect(dispatch?.durations?.leaseExpiresInMs).toBe(19 * 60_000);
  });

  it('links pending downstream task attempts to upstream blocker nodes', () => {
    const upstream = task({ id: 'upstream', status: 'failed' });
    const downstream = task({ id: 'downstream', status: 'pending', dependencies: ['upstream'] });
    const graph = buildActionGraphDiagnostics({
      workflows: [workflow],
      tasks: [upstream, downstream],
      attemptsByTaskId: new Map([
        ['downstream', [attempt({ id: 'downstream-a1', nodeId: 'downstream' })]],
      ]),
      queueStatus: { maxConcurrency: 1, runningCount: 0, running: [], queued: [] },
      mutationIntents: [],
      mutationLeases: [],
      eventsByTaskId: new Map(),
      activityLogs: [],
      stallThresholdMs: 60_000,
      now,
    });

    expect(graph.nodes.find((node) => node.id === 'blocker:downstream:dependency:upstream')).toEqual(
      expect.objectContaining({ type: 'blocker', status: 'waiting' }),
    );
    expect(graph.edges).toContainEqual(expect.objectContaining({
      source: 'blocker:downstream:dependency:upstream',
      target: 'attempt:downstream-a1',
    }));
  });

  it('creates blocker nodes for launch errors and missing workspaces', () => {
    const failed = task({
      id: 'launch-failed',
      status: 'failed',
      execution: { phase: 'launching', error: 'spawn failed: missing workspace' },
    });
    const graph = buildActionGraphDiagnostics({
      workflows: [workflow],
      tasks: [failed],
      attemptsByTaskId: new Map(),
      queueStatus: { maxConcurrency: 1, runningCount: 0, running: [], queued: [] },
      mutationIntents: [],
      mutationLeases: [],
      eventsByTaskId: new Map(),
      activityLogs: [],
      stallThresholdMs: 60_000,
      now,
    });

    expect(graph.nodes.find((node) => node.id === 'blocker:launch-failed:error')?.label).toBe('Launch failed');
    expect(graph.nodes.find((node) => node.id === 'blocker:launch-failed:workspace')?.label).toBe('Missing workspace');
  });

  it('keeps only the latest task events in selected attempt history', () => {
    const selectedAttempt = attempt({ id: 'attempt-a1', nodeId: 'task-a' });
    const events: TaskEvent[] = Array.from({ length: 30 }, (_value, index) => ({
      id: index + 1,
      taskId: 'task-a',
      eventType: `event-${index}`,
      payload: `payload-${index}`,
      createdAt: new Date(Date.UTC(2026, 4, 14, 11, index)).toISOString(),
    }));

    const graph = buildActionGraphDiagnostics({
      workflows: [workflow],
      tasks: [task({ id: 'task-a', execution: { selectedAttemptId: selectedAttempt.id } })],
      attemptsByTaskId: new Map([['task-a', [selectedAttempt]]]),
      queueStatus: { maxConcurrency: 1, runningCount: 0, running: [], queued: [] },
      mutationIntents: [],
      mutationLeases: [],
      eventsByTaskId: new Map([['task-a', events]]),
      activityLogs: [],
      stallThresholdMs: 60_000,
      now,
    });

    const selected = graph.nodes.find((node) => node.id === 'attempt:attempt-a1');
    expect(selected?.history?.map((entry) => entry.source)).toEqual(
      Array.from({ length: 20 }, (_value, index) => `event-${index + 10}`),
    );
  });

  it('caps verbose diagnostic text in action graph nodes', () => {
    const longText = 'x'.repeat(20_000);
    const selectedAttempt = attempt({
      id: 'attempt-a1',
      nodeId: 'task-a',
      error: longText,
    });
    const graph = buildActionGraphDiagnostics({
      workflows: [workflow],
      tasks: [task({
        id: 'task-a',
        description: longText,
        execution: { selectedAttemptId: selectedAttempt.id },
      })],
      attemptsByTaskId: new Map([['task-a', [selectedAttempt]]]),
      queueStatus: { maxConcurrency: 1, runningCount: 0, running: [], queued: [] },
      mutationIntents: [{
        id: 9,
        workflowId: 'wf-1',
        channel: 'invoker:fix-with-agent',
        args: [],
        priority: 'high',
        status: 'failed',
        createdAt: '2026-05-14T11:55:00.000Z',
        error: longText,
      }],
      mutationLeases: [],
      eventsByTaskId: new Map([['task-a', [{
        id: 1,
        taskId: 'task-a',
        eventType: 'output',
        payload: longText,
        createdAt: '2026-05-14T11:59:00.000Z',
      }]]]),
      activityLogs: [],
      stallThresholdMs: 60_000,
      now,
    });

    const attemptNode = graph.nodes.find((node) => node.id === 'attempt:attempt-a1');
    const intentNode = graph.nodes.find((node) => node.id === 'intent:9');
    expect(attemptNode?.label.length).toBeLessThan(2_100);
    expect(attemptNode?.latestError?.length).toBeLessThan(8_300);
    expect(attemptNode?.history?.[0]?.message.length).toBeLessThan(2_100);
    expect(intentNode?.latestError?.length).toBeLessThan(8_300);
    expect(attemptNode?.latestError).toContain('truncated');
  });

  it('skips upstream attempt edges whose source attempts are omitted', () => {
    const upstream = task({ id: 'upstream', status: 'failed' });
    const downstream = task({ id: 'downstream', status: 'pending', dependencies: ['upstream'] });
    const downstreamAttempt = attempt({
      id: 'downstream-a1',
      nodeId: 'downstream',
      upstreamAttemptIds: ['old-upstream-a1'],
    });

    const graph = buildActionGraphDiagnostics({
      workflows: [workflow],
      tasks: [upstream, downstream],
      attemptsByTaskId: new Map([['downstream', [downstreamAttempt]]]),
      queueStatus: { maxConcurrency: 1, runningCount: 0, running: [], queued: [] },
      mutationIntents: [],
      mutationLeases: [],
      eventsByTaskId: new Map(),
      activityLogs: [],
      stallThresholdMs: 60_000,
      now,
    });

    expect(graph.edges).not.toContainEqual(expect.objectContaining({
      source: 'attempt:old-upstream-a1',
      target: 'attempt:downstream-a1',
    }));
    expect(graph.nodes.find((node) => node.id === 'blocker:downstream:dependency:upstream')).toEqual(
      expect.objectContaining({ type: 'blocker', status: 'waiting' }),
    );
  });
});

describe('resolveActionDiagnosticsStallThresholdMs', () => {
  it('uses config before env and falls back to default', () => {
    expect(resolveActionDiagnosticsStallThresholdMs({ actionDiagnostics: { stallThresholdMs: 12_000 } }, {
      INVOKER_ACTION_STALL_THRESHOLD_MS: '5000',
    })).toBe(12_000);
    expect(resolveActionDiagnosticsStallThresholdMs({}, { INVOKER_ACTION_STALL_THRESHOLD_MS: '5000' })).toBe(5_000);
    expect(resolveActionDiagnosticsStallThresholdMs({}, { INVOKER_ACTION_STALL_THRESHOLD_MS: 'bad' })).toBe(60_000);
  });
});

