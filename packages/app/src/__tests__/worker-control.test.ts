import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_FIX_WORKER_KIND,
  CI_FAILURE_WORKER_KIND,
  CODERABBIT_ADDRESS_WORKER_KIND,
  E2E_AUTOFIX_WORKER_KIND,
  createWorkerRegistry,
  PR_CONFLICT_REBASE_WORKER_KIND,
  PR_STATUS_WORKER_KIND,
  WORKFLOW_RESUME_WORKER_KIND,
  type WorkerRuntime,
  type WorkerRuntimeDependencies,
} from '@invoker/execution-engine';

import type { WorkerActionRecord } from '@invoker/data-store';
import {
  AUTO_STARTED_OWNER_WORKER_KINDS,
  createWorkerRuntimeController,
  listWorkerActionHistory,
  listWorkerDecisions,
  toWorkerActionSummary,
} from '../worker-control.js';

interface TestWorkerRuntime extends WorkerRuntime {
  forceExit: () => void;
  readonly starts: number;
  readonly stops: number;
}

function runtime(kind: string): TestWorkerRuntime {
  let running = false;
  let starts = 0;
  let stops = 0;
  return {
    identity: { kind, instanceId: `${kind}-instance` },
    start: vi.fn(() => {
      starts += 1;
      running = true;
    }),
    wake: vi.fn(),
    tick: vi.fn(async () => {}),
    stop: vi.fn(async () => {
      stops += 1;
      running = false;
    }),
    isRunning: vi.fn(() => running),
    forceExit: () => { running = false; },
    get starts() { return starts; },
    get stops() { return stops; },
  };
}

function persistence(initialDesired: Record<string, boolean> = {}) {
  const desired = new Map(Object.entries(initialDesired));
  return {
    listWorkerActions: vi.fn(() => []),
    listWorkflows: vi.fn(() => []),
    loadTasks: vi.fn(() => []),
    getEvents: vi.fn(() => []),
    getEventsByTypes: vi.fn(() => []),
    countEventsByTypes: vi.fn(() => []),
    getWorkerDesiredState: vi.fn((workerKind: string) => (
      desired.has(workerKind)
        ? { workerKind, desiredEnabled: desired.get(workerKind) === true, updatedAt: '2026-01-01T00:00:00.000Z' }
        : undefined
    )),
    setWorkerDesiredState: vi.fn((workerKind: string, desiredEnabled: boolean) => {
      desired.set(workerKind, desiredEnabled);
      return { workerKind, desiredEnabled, updatedAt: '2026-01-01T00:00:00.000Z' };
    }),
    listWorkerDesiredStates: vi.fn(() => Array.from(desired.entries()).map(([workerKind, desiredEnabled]) => ({
      workerKind,
      desiredEnabled,
      updatedAt: '2026-01-01T00:00:00.000Z',
    }))),
  };
}

function deps(): WorkerRuntimeDependencies {
  return {
    store: {} as WorkerRuntimeDependencies['store'],
    submitter: { submit: vi.fn(() => 1) },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as WorkerRuntimeDependencies;
}

function controller(
  autoStartKinds: readonly string[] = AUTO_STARTED_OWNER_WORKER_KINDS,
  desiredState: Record<string, boolean> = {},
) {
  const registry = createWorkerRegistry<WorkerRuntimeDependencies>();
  const runtimes = new Map<string, TestWorkerRuntime[]>();
  const store = persistence(desiredState);
  const register = (kind: string, note: string, runtimeKind = kind) => {
    registry.register({
      kind,
      note,
      factory: () => {
        const created = runtime(runtimeKind);
        const list = runtimes.get(kind) ?? [];
        list.push(created);
        runtimes.set(kind, list);
        return created;
      },
    });
  };
  register(AUTO_FIX_WORKER_KIND, 'Auto-fixes failed tasks.', 'recovery');
  register(PR_STATUS_WORKER_KIND, 'Checks pull request status.');
  register(CI_FAILURE_WORKER_KIND, 'Repairs failed CI.');
  register(CODERABBIT_ADDRESS_WORKER_KIND, 'Addresses CodeRabbit review comments.');
  register(PR_CONFLICT_REBASE_WORKER_KIND, 'Rebases conflicted pull requests.');
  register(WORKFLOW_RESUME_WORKER_KIND, 'Resumes incomplete workflows.');
  register(E2E_AUTOFIX_WORKER_KIND, 'Runs the extended e2e battery on a schedule.');
  register('external-preview', 'External preview worker.');

  return {
    runtimes,
    persistence: store,
    controller: createWorkerRuntimeController({
      registry,
      deps: deps(),
      autoStartKinds,
      persistence: store as never,
      canControl: () => true,
    }),
  };
}

describe('createWorkerRuntimeController', () => {
  it('auto-start starts every built-in owner worker except autofix and workflow-resume', () => {
    const setup = controller();

    setup.controller.startAutoStartedWorkers();
    const snapshot = setup.controller.snapshot();

    expect(snapshot.workers.find((worker) => worker.kind === PR_STATUS_WORKER_KIND)?.lifecycle).toBe('running');
    expect(snapshot.workers.find((worker) => worker.kind === CI_FAILURE_WORKER_KIND)?.lifecycle).toBe('running');
    expect(snapshot.workers.find((worker) => worker.kind === CODERABBIT_ADDRESS_WORKER_KIND)?.lifecycle).toBe('running');
    expect(snapshot.workers.find((worker) => worker.kind === PR_CONFLICT_REBASE_WORKER_KIND)?.lifecycle).toBe('running');
    expect(snapshot.workers.find((worker) => worker.kind === WORKFLOW_RESUME_WORKER_KIND)?.lifecycle).toBe('stopped');
    expect(snapshot.workers.find((worker) => worker.kind === WORKFLOW_RESUME_WORKER_KIND)?.startable).toBe(true);
    expect(snapshot.workers.find((worker) => worker.kind === AUTO_FIX_WORKER_KIND)?.lifecycle).toBe('stopped');
    expect(snapshot.workers.find((worker) => worker.kind === 'external-preview')?.lifecycle).toBe('stopped');
  });

  it('restores saved desired worker states over built-in launch defaults', () => {
    const setup = controller(AUTO_STARTED_OWNER_WORKER_KINDS, {
      [PR_STATUS_WORKER_KIND]: false,
      [WORKFLOW_RESUME_WORKER_KIND]: true,
    });

    setup.controller.startAutoStartedWorkers();
    const snapshot = setup.controller.snapshot();

    expect(snapshot.workers.find((worker) => worker.kind === PR_STATUS_WORKER_KIND)).toMatchObject({
      lifecycle: 'stopped',
      desiredEnabled: false,
      autoStarts: false,
    });
    expect(snapshot.workers.find((worker) => worker.kind === WORKFLOW_RESUME_WORKER_KIND)).toMatchObject({
      lifecycle: 'running',
      desiredEnabled: true,
      autoStarts: true,
    });
    expect(setup.persistence.setWorkerDesiredState).not.toHaveBeenCalled();
  });

  it('persists manual worker enable and disable state', async () => {
    const setup = controller();

    setup.controller.start(WORKFLOW_RESUME_WORKER_KIND);
    await setup.controller.stop(WORKFLOW_RESUME_WORKER_KIND);

    expect(setup.persistence.setWorkerDesiredState).toHaveBeenNthCalledWith(1, WORKFLOW_RESUME_WORKER_KIND, true);
    expect(setup.persistence.setWorkerDesiredState).toHaveBeenNthCalledWith(2, WORKFLOW_RESUME_WORKER_KIND, false);
    expect(setup.controller.snapshot().workers.find((worker) => worker.kind === WORKFLOW_RESUME_WORKER_KIND)).toMatchObject({
      lifecycle: 'stopped',
      desiredEnabled: false,
      autoStarts: false,
    });
  });

  it('auto-starts e2e-autofix only when its kind is in autoStartKinds', () => {
    const gated = controller([...AUTO_STARTED_OWNER_WORKER_KINDS, E2E_AUTOFIX_WORKER_KIND]);
    gated.controller.startAutoStartedWorkers();
    const gatedRow = gated.controller.snapshot().workers.find((worker) => worker.kind === E2E_AUTOFIX_WORKER_KIND);
    expect(gatedRow?.lifecycle).toBe('running');

    const ungated = controller();
    ungated.controller.startAutoStartedWorkers();
    const ungatedRow = ungated.controller.snapshot().workers.find((worker) => worker.kind === E2E_AUTOFIX_WORKER_KIND);
    expect(ungatedRow?.lifecycle).toBe('stopped');
    expect(ungatedRow?.startable).toBe(true);
  });

  it('autofix remains stopped until explicitly started', () => {
    const setup = controller();

    setup.controller.startAutoStartedWorkers();
    expect(setup.runtimes.get(AUTO_FIX_WORKER_KIND)).toBeUndefined();

    const row = setup.controller.start(AUTO_FIX_WORKER_KIND);

    expect(row.lifecycle).toBe('running');
    expect(row.runtimeKind).toBe('recovery');
  });

  it('duplicate start is idempotent', () => {
    const setup = controller();

    setup.controller.start(PR_STATUS_WORKER_KIND);
    setup.controller.start(PR_STATUS_WORKER_KIND);

    expect(setup.runtimes.get(PR_STATUS_WORKER_KIND)).toHaveLength(1);
  });

  it('stop is idempotent', async () => {
    const setup = controller();

    const stoppedBeforeStart = await setup.controller.stop(PR_STATUS_WORKER_KIND);
    expect(stoppedBeforeStart.lifecycle).toBe('stopped');

    setup.controller.start(PR_STATUS_WORKER_KIND);
    const stopped = await setup.controller.stop(PR_STATUS_WORKER_KIND);
    const stoppedAgain = await setup.controller.stop(PR_STATUS_WORKER_KIND);

    expect(stopped.lifecycle).toBe('stopped');
    expect(stoppedAgain.lifecycle).toBe('stopped');
    expect(setup.runtimes.get(PR_STATUS_WORKER_KIND)?.[0]?.stops).toBe(1);
  });

  it('built-in worker policy stays enabled for maintenance workers', () => {
    const setup = controller();

    for (const kind of [
      AUTO_FIX_WORKER_KIND,
      CI_FAILURE_WORKER_KIND,
      CODERABBIT_ADDRESS_WORKER_KIND,
      PR_CONFLICT_REBASE_WORKER_KIND,
    ] as const) {
      expect(setup.controller.start(kind)).toMatchObject({
        kind,
        lifecycle: 'running',
        policy: 'enabled',
        startable: false,
      });
    }
  });

  it('an exited external worker row reports exited', () => {
    const setup = controller();

    setup.controller.start('external-preview');
    setup.runtimes.get('external-preview')?.[0]?.forceExit();

    expect(setup.controller.snapshot().workers.find((worker) => worker.kind === 'external-preview')).toMatchObject({
      lifecycle: 'exited',
      policy: 'unknown',
    });
  });

  it('keeps status recentActions capped to five items', () => {
    const registry = createWorkerRegistry<WorkerRuntimeDependencies>();
    registry.register({
      kind: 'history',
      note: 'History worker.',
      factory: () => runtime('history'),
    });
    const listWorkerActions = vi.fn(() => Array.from({ length: 6 }, (_value, index) => ({
      id: `wa-${index}`,
      workerKind: 'history',
      actionType: 'check',
      subjectType: 'task',
      subjectId: `task-${index}`,
      externalKey: `key-${index}`,
      status: 'completed',
      attemptCount: 1,
      createdAt: `2026-01-01T00:00:0${index}.000Z`,
      updatedAt: `2026-01-01T00:00:0${index}.000Z`,
    })));

    const controller = createWorkerRuntimeController({
      registry,
      deps: deps(),
      autoStartKinds: [],
      persistence: { ...persistence(), listWorkerActions } as never,
      canControl: () => true,
    });

    const worker = controller.snapshot().workers[0];
    expect(listWorkerActions).toHaveBeenCalledWith({ workerKind: 'history', limit: 5 });
    expect(worker?.recentActions).toHaveLength(5);
  });

it('returns worker action history with paging metadata', () => {
    const listWorkerActions = vi.fn(() => Array.from({ length: 3 }, (_value, index) => ({
      id: `wa-${index}`,
      workerKind: 'history',
      actionType: 'check',
      subjectType: 'task',
      subjectId: `task-${index}`,
      externalKey: `key-${index}`,
      status: 'completed',
      attemptCount: 1,
      createdAt: `2026-01-01T00:00:0${index}.000Z`,
      updatedAt: `2026-01-01T00:00:0${index}.000Z`,
    })));

    expect(listWorkerActionHistory({ listWorkerActions } as never, { workerKind: ' history ', limit: 2, offset: 4 })).toMatchObject({
      workerKind: 'history',
      actions: [{ id: 'wa-0' }, { id: 'wa-1' }],
      limit: 2,
      offset: 4,
      hasMore: true,
      nextOffset: 6,
    });
    expect(listWorkerActions).toHaveBeenCalledWith({ workerKind: 'history', limit: 3, offset: 4 });
  });
});

function decisionRow(overrides: Partial<WorkerActionRecord> = {}): WorkerActionRecord {
  return {
    id: 'wa',
    workerKind: 'autofix',
    actionType: 'auto-fix',
    subjectType: 'task',
    subjectId: 'wf-1/t',
    externalKey: 'autofix:wf-1/t:0:a1',
    status: 'queued',
    attemptCount: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('toWorkerActionSummary', () => {
  it('derives decision from status and lifts reason from payload', () => {
    const skip = toWorkerActionSummary(decisionRow({ id: 's', status: 'skipped', payload: { reason: 'not-eligible' } }));
    expect(skip).toMatchObject({ decision: 'skip', reason: 'not-eligible' });
    const act = toWorkerActionSummary(decisionRow({ id: 'a', status: 'queued', payload: {} }));
    expect(act.decision).toBe('act');
    expect(act.reason).toBeUndefined();
  });
});

describe('listWorkerDecisions', () => {
  it('scopes to a run and surfaces reason + decision on each summary', () => {
    const listWorkerActions = vi.fn(() => [
      decisionRow({ id: 'a1', status: 'queued', payload: {} }),
      decisionRow({ id: 'a2', status: 'skipped', payload: { reason: 'worker-retry-budget-exhausted' } }),
    ]);
    const res = listWorkerDecisions({ listWorkerActions } as never, { workflowId: 'wf-1' });
    expect(listWorkerActions).toHaveBeenCalledWith(expect.objectContaining({ workflowId: 'wf-1' }));
    expect(res.workflowId).toBe('wf-1');
    expect(res.actions.map((action) => action.decision)).toEqual(['act', 'skip']);
    expect(res.actions[1]?.reason).toBe('worker-retry-budget-exhausted');
  });

  it('passes the decision filter through to the query', () => {
    const listWorkerActions = vi.fn(() => []);
    listWorkerDecisions({ listWorkerActions } as never, { decision: 'skip', workerKind: 'autofix' });
    expect(listWorkerActions).toHaveBeenCalledWith(expect.objectContaining({ decision: 'skip', workerKind: 'autofix' }));
  });

  it('post-filters by reason substring, case-insensitively', () => {
    const listWorkerActions = vi.fn(() => [
      decisionRow({ id: 'a1', status: 'skipped', payload: { reason: 'not-eligible' } }),
      decisionRow({ id: 'a2', status: 'skipped', payload: { reason: 'worker-retry-budget-exhausted' } }),
    ]);
    const res = listWorkerDecisions({ listWorkerActions } as never, { reason: 'BUDGET' });
    expect(res.actions.map((action) => action.id)).toEqual(['a2']);
  });
});
