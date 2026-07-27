import { describe, expect, it, vi } from 'vitest';

import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import type { PlanDefinition, TaskState } from '@invoker/workflow-core';

import { autoFixRetryCapExternalKey } from '../auto-fix-retry-cap.js';
import type { ReviewGateCiFailedLifecycleEvent } from '../lifecycle-events.js';
import {
  buildRepairWorkflowSpec,
  parseSpawnRepairWorkflowMutationArgs,
  queueRepairWorkflowSpawn,
  repairWorkflowActionKey,
  submitRepairWorkflowFromCiFailure,
} from '../repair-workflow-spec.js';

const now = '2026-01-01T00:00:00.000Z';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
};

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  const { config, execution, ...rest } = overrides;
  return {
    id: 'wf-upstream/merge',
    description: 'merge',
    status: 'review_ready',
    dependencies: [],
    createdAt: new Date(now),
    config: { workflowId: 'wf-upstream', isMergeNode: true, ...(config ?? {}) },
    execution: {
      generation: 3,
      selectedAttemptId: 'attempt-merge',
      branch: 'feature/ci',
      ...(execution ?? {}),
    },
    taskStateVersion: 12,
    ...rest,
  } as TaskState;
}

function makeEvent(overrides: Partial<ReviewGateCiFailedLifecycleEvent> = {}): ReviewGateCiFailedLifecycleEvent {
  return {
    eventKey: 'review_gate.ci_failed|workflow:wf-upstream|task:wf-upstream/merge',
    kind: 'review_gate.ci_failed',
    workflowId: 'wf-upstream',
    taskId: 'wf-upstream/merge',
    status: 'review_ready',
    taskStateVersion: 12,
    generation: 3,
    attemptId: 'attempt-merge',
    createdAt: now,
    recoveryWakeup: {
      eventKey: 'review_gate.ci_failed|workflow:wf-upstream|task:wf-upstream/merge',
      eventKind: 'review_gate.ci_failed',
      workflowId: 'wf-upstream',
      taskId: 'wf-upstream/merge',
      taskStateVersion: 12,
      generation: 3,
      attemptId: 'attempt-merge',
      createdAt: now,
      reason: 'review_gate_failure',
      authoritative: false,
    },
    reviewId: '123',
    reviewUrl: 'https://github.com/owner/repo/pull/123',
    headSha: 'abcdef1234567890abcdef1234567890abcdef12',
    headRef: 'feature/ci',
    branch: 'feature/ci',
    failedChecks: [
      { name: 'unit', conclusion: 'FAILURE', detailsUrl: 'https://github.com/owner/repo/actions/1' },
      { name: 'lint', conclusion: 'FAILURE', detailsUrl: 'https://github.com/owner/repo/actions/2' },
    ],
    statusText: 'CI failed',
    ...overrides,
  };
}

function toRecord(write: WorkerActionWrite, existing?: WorkerActionRecord): WorkerActionRecord {
  return {
    ...write,
    id: existing?.id ?? write.id,
    attemptCount: write.attemptCount ?? 0,
    createdAt: existing?.createdAt ?? now,
    updatedAt: write.updatedAt ?? now,
  };
}

function makeHarness(task = makeTask()) {
  const actions = new Map<string, WorkerActionRecord>();
  const loadedPlans: PlanDefinition[] = [];
  const createdTasks: TaskState[] = [];
  const workflowIds = ['wf-upstream'];
  const store = {
    loadTasks: vi.fn((workflowId: string) => (workflowId === 'wf-upstream' ? [task] : [])),
    loadTask: vi.fn((taskId: string) => (taskId === task.id ? task : undefined)),
    loadWorkflow: vi.fn((workflowId: string) => workflowId === 'wf-upstream'
      ? {
        id: 'wf-upstream',
        name: 'Upstream',
        repoUrl: 'git@github.com:owner/repo.git',
        intermediateRepoUrl: 'git@github.com:owner/branches.git',
        featureBranch: 'feature/ci',
        baseBranch: 'master',
      }
      : undefined),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const key = `${write.workerKind}:${write.externalKey}`;
      const saved = toRecord(write, actions.get(key));
      actions.set(key, saved);
      return saved;
    }),
    logEvent: vi.fn(),
  };
  const orchestrator = {
    getWorkflowIds: vi.fn(() => [...workflowIds]),
    loadPlan: vi.fn((plan: PlanDefinition) => {
      loadedPlans.push(plan);
      const workflowId = `wf-repair-${loadedPlans.length}`;
      workflowIds.push(workflowId);
      createdTasks.splice(0, createdTasks.length, ...plan.tasks.map((taskDef) => makeTask({
        id: `${workflowId}/${taskDef.id}`,
        description: taskDef.description,
        dependencies: taskDef.dependencies ?? [],
        config: { workflowId, command: taskDef.command, prompt: taskDef.prompt },
        execution: {},
        status: 'queued',
      })));
    }),
    startExecution: vi.fn(() => [...createdTasks]),
    getAllTasks: vi.fn(() => [task, ...createdTasks]),
  };
  return { actions, createdTasks, loadedPlans, orchestrator, store };
}

describe('repair workflow spawn', () => {
  it('builds the repair workflow spec shape', () => {
    const event = makeEvent();
    const spec = buildRepairWorkflowSpec({
      event,
      upstreamWorkflowId: 'wf-upstream',
      upstreamFeatureBranch: 'feature/ci',
      prHeadSha: event.headSha,
      failedCheckNames: ['unit', 'lint'],
      repoUrl: 'git@github.com:owner/repo.git',
      intermediateRepoUrl: 'git@github.com:owner/branches.git',
      executionAgent: 'codex',
      executionModel: 'openai/gpt-5.2',
    });

    expect(spec.onFinish).toBe('none');
    expect(spec.baseBranch).toBe(event.headSha);
    expect(spec.featureBranch).toBe('repair/feature/ci-abcdef123456');
    expect(spec.externalDependencies).toEqual([{
      workflowId: 'wf-upstream',
      taskId: '__merge__',
      gatePolicy: 'ci_failed',
    }]);
    expect(spec.tasks).toHaveLength(2);
    expect(spec.tasks[0]).toMatchObject({
      id: 'repair-ci',
      executionAgent: 'codex',
      executionModel: 'openai/gpt-5.2',
    });
    expect(spec.tasks[1]).toMatchObject({
      id: 'publish-repair',
      dependencies: ['repair-ci'],
    });
  });

  it('dedupes identical PR/head-SHA repair submissions', () => {
    const event = makeEvent();
    const harness = makeHarness();

    const first = submitRepairWorkflowFromCiFailure({
      store: harness.store,
      orchestrator: harness.orchestrator,
      logger,
      defaultAutoFixRetries: 2,
    }, {
      event,
      upstreamWorkflowId: 'wf-upstream',
      upstreamFeatureBranch: 'feature/ci',
      prHeadSha: event.headSha!,
      failedCheckNames: ['unit', 'lint'],
    });
    const second = submitRepairWorkflowFromCiFailure({
      store: harness.store,
      orchestrator: harness.orchestrator,
      logger,
      defaultAutoFixRetries: 2,
    }, {
      event,
      upstreamWorkflowId: 'wf-upstream',
      upstreamFeatureBranch: 'feature/ci',
      prHeadSha: event.headSha!,
      failedCheckNames: ['unit', 'lint'],
    });

    expect(first.decision).toBe('spawned');
    expect(second).toMatchObject({ decision: 'skipped', reason: 'already-recorded' });
    expect(harness.orchestrator.loadPlan).toHaveBeenCalledTimes(1);
    expect(harness.actions.get(`ci-failure:${repairWorkflowActionKey(event)}`)).toMatchObject({
      actionType: 'spawn-repair-workflow',
      status: 'queued',
      payload: expect.objectContaining({ repairWorkflowId: 'wf-repair-1' }),
    });
  });

  it('spawns freshly for a new PR head SHA', () => {
    const harness = makeHarness();
    const event = makeEvent();

    for (const prHeadSha of [event.headSha!, '1234567890abcdef1234567890abcdef12345678']) {
      const result = submitRepairWorkflowFromCiFailure({
        store: harness.store,
        orchestrator: harness.orchestrator,
        logger,
        defaultAutoFixRetries: 2,
      }, {
        event,
        upstreamWorkflowId: 'wf-upstream',
        upstreamFeatureBranch: 'feature/ci',
        prHeadSha,
        failedCheckNames: ['unit', 'lint'],
      });
      expect(result.decision).toBe('spawned');
    }

    expect(harness.orchestrator.loadPlan).toHaveBeenCalledTimes(2);
    expect(harness.loadedPlans.map((plan) => plan.featureBranch)).toEqual([
      'repair/feature/ci-abcdef123456',
      'repair/feature/ci-1234567890ab',
    ]);
  });

  it('stops spawning when the shared per-task retry cap is exhausted', () => {
    const harness = makeHarness();
    const firstEvent = makeEvent();
    const secondEvent = makeEvent({
      headSha: '1234567890abcdef1234567890abcdef12345678',
    });

    const first = submitRepairWorkflowFromCiFailure({
      store: harness.store,
      orchestrator: harness.orchestrator,
      logger,
      defaultAutoFixRetries: 1,
    }, {
      event: firstEvent,
      upstreamWorkflowId: 'wf-upstream',
      upstreamFeatureBranch: 'feature/ci',
      prHeadSha: firstEvent.headSha!,
      failedCheckNames: ['unit', 'lint'],
    });
    const second = submitRepairWorkflowFromCiFailure({
      store: harness.store,
      orchestrator: harness.orchestrator,
      logger,
      defaultAutoFixRetries: 1,
    }, {
      event: secondEvent,
      upstreamWorkflowId: 'wf-upstream',
      upstreamFeatureBranch: 'feature/ci',
      prHeadSha: secondEvent.headSha!,
      failedCheckNames: ['unit', 'lint'],
    });

    expect(first.decision).toBe('spawned');
    expect(second).toMatchObject({ decision: 'skipped', reason: 'worker-retry-budget-exhausted' });
    expect(harness.orchestrator.loadPlan).toHaveBeenCalledTimes(1);
    expect(harness.actions.get(`autofix:${autoFixRetryCapExternalKey('wf-upstream/merge')}`)).toMatchObject({
      attemptCount: 1,
    });
  });

  it('lets explicit command submissions bypass the worker retry cap', () => {
    const harness = makeHarness();
    const event = makeEvent();
    const payload = parseSpawnRepairWorkflowMutationArgs([{
      event,
      upstreamWorkflowId: 'wf-upstream',
      upstreamFeatureBranch: 'feature/ci',
      prHeadSha: event.headSha,
      failedCheckNames: ['unit', 'lint'],
    }]);

    const result = submitRepairWorkflowFromCiFailure({
      store: harness.store,
      orchestrator: harness.orchestrator,
      logger,
      defaultAutoFixRetries: 0,
    }, payload);

    expect(payload.source).toBe('human');
    expect(result).toMatchObject({ decision: 'spawned', workflowId: 'wf-repair-1' });
    expect(harness.actions.get(`autofix:${autoFixRetryCapExternalKey('wf-upstream/merge')}`)).toBeUndefined();
  });

  it('honors a queued worker reservation without consuming the retry cap twice', () => {
    const harness = makeHarness();
    const event = makeEvent();
    const submitted: unknown[][] = [];
    const submitter = {
      submit: vi.fn((_workflowId: string, _priority: string, _channel: string, args: unknown[]) => {
        submitted.push(args);
        return 17;
      }),
    };

    const queued = queueRepairWorkflowSpawn({
      store: harness.store,
      submitter,
      logger,
      defaultAutoFixRetries: 1,
    }, event);
    const spawned = submitRepairWorkflowFromCiFailure({
      store: harness.store,
      orchestrator: harness.orchestrator,
      logger,
      defaultAutoFixRetries: 1,
    }, submitted[0]![0] as Parameters<typeof submitRepairWorkflowFromCiFailure>[1]);

    expect(queued).toMatchObject({ decision: 'queued', intentId: 17 });
    expect(spawned).toMatchObject({ decision: 'spawned', workflowId: 'wf-repair-1' });
    expect(harness.actions.get(`autofix:${autoFixRetryCapExternalKey('wf-upstream/merge')}`)).toMatchObject({
      attemptCount: 1,
    });
    expect(harness.actions.get(`ci-failure:${repairWorkflowActionKey(event)}`)).toMatchObject({
      attemptCount: 1,
      payload: expect.objectContaining({ repairWorkflowId: 'wf-repair-1' }),
    });
  });

  it('wires fast-forward refusal into the final publish step', () => {
    const event = makeEvent();
    const spec = buildRepairWorkflowSpec({
      event,
      upstreamWorkflowId: 'wf-upstream',
      upstreamFeatureBranch: 'feature/ci',
      prHeadSha: event.headSha,
      failedCheckNames: ['unit', 'lint'],
      repoUrl: 'git@github.com:owner/repo.git',
    });

    const publish = spec.tasks.find((task) => task.id === 'publish-repair');
    expect(publish?.command).toContain('current_head="$(git rev-parse "refs/remotes/${remote}/${feature_branch}^{commit}")"');
    expect(publish?.command).toContain('if [ "$current_head" != "$expected_head" ]; then');
    expect(publish?.command).toContain('exit 42');
    expect(publish?.command).toContain('git merge-base --is-ancestor "$expected_head" HEAD');
    expect(publish?.command).toContain('git push "$remote" "HEAD:refs/heads/${feature_branch}"');
    expect(publish?.command).toContain('git push --force-with-lease "$remote" "HEAD:refs/heads/${repair_branch}"');
    expect(publish?.command).not.toContain('git push --force "$remote" "HEAD:refs/heads/${feature_branch}"');
    expect(publish?.command).not.toContain('git merge ');
  });
});
