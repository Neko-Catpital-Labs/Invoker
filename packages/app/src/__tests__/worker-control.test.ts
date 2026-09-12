import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_APPROVE_WORKER_KIND,
  AUTO_FIX_WORKER_KIND,
  CLAUDE_OAUTH_REFRESH_WORKER_KIND,
  DISK_HEADROOM_WORKER_KIND,
  PR_ADMIN_BYPASS_LAND_WORKER_KIND,
  PR_AUTO_LABEL_WORKER_KIND,
  PR_DUPLICATE_CLOSE_WORKER_KIND,
  PR_ORPHAN_REPAIR_WORKER_KIND,
  E2E_AUTOFIX_WORKER_KIND,
  createWorkerRegistry,
  IDLE_TASK_CLEANUP_WORKER_KIND,
  INFRA_REPAIR_WORKER_KIND,
  PR_JAILBREAK_LAND_WORKER_KIND,
  PR_STATUS_WORKER_KIND,
  REAPER_WORKER_KIND,
  REQUEUE_WORKER_KIND,
  WORKFLOW_RESUME_WORKER_KIND,
  type WorkerRuntime,
  type WorkerRuntimeDependencies,
} from '@invoker/execution-engine';

import type { WorkerActionRecord } from '@invoker/data-store';
import type { WorkerStatusSnapshot } from '@invoker/contracts';
import {
  ALWAYS_AUTO_STARTED_OWNER_WORKER_KINDS,
  autoStartedOwnerWorkerKinds,
  autoStartedOwnerWorkerKindsForConfig,
  createLocalWorkerStatusSnapshot,
  createOwnerWorkerStatusReader,
  createWorkerRuntimeController,
  legacyWorkerStartFlagSeeds,
  listWorkerActionHistory,
  listWorkerDecisions,
  migrateWorkerDesiredStateFromLegacyConfig,
  PR_MAINTENANCE_AUTO_STARTED_WORKER_KINDS,
  toWorkerActionSummary,
} from '../worker-control.js';

function ownerSnapshot(
  generatedAt: string,
  lifecycles: Record<string, 'running' | 'stopped'>,
): WorkerStatusSnapshot {
  return {
    generatedAt,
    workers: Object.entries(lifecycles).map(([kind, lifecycle]) => ({
      kind,
      note: `${kind} worker`,
      lifecycle,
      policy: 'enabled',
      autoStarts: lifecycle === 'running',
      startable: lifecycle !== 'running',
      stoppable: lifecycle === 'running',
      recentActions: [],
    })),
  };
}

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
  autoStartKinds: readonly string[] = autoStartedOwnerWorkerKinds(),
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
  register(INFRA_REPAIR_WORKER_KIND, 'Repairs infra-owned SSH and CI failures.');
  register(PR_ADMIN_BYPASS_LAND_WORKER_KIND, 'Lands eligible PRs via admin bypass.');
  register(PR_ORPHAN_REPAIR_WORKER_KIND, 'Repairs unmapped broken pull requests.');
  register(PR_DUPLICATE_CLOSE_WORKER_KIND, 'Closes duplicate or already-landed pull requests.');
  register(PR_JAILBREAK_LAND_WORKER_KIND, 'Force-merges eligible jailbreak PRs via admin bypass.');
  register(PR_AUTO_LABEL_WORKER_KIND, 'Auto-labels refactor/bugfix/repro/test-only PRs with admin-bypass.');
  register(WORKFLOW_RESUME_WORKER_KIND, 'Resumes incomplete workflows.');
  register(REAPER_WORKER_KIND, 'Reaps stale Invoker-managed artifacts.');
  register(E2E_AUTOFIX_WORKER_KIND, 'Runs the extended e2e battery on a schedule.');
  register(DISK_HEADROOM_WORKER_KIND, 'Monitors disk headroom.');
  register(AUTO_APPROVE_WORKER_KIND, 'Auto-approves AI fixes.');
  register(CLAUDE_OAUTH_REFRESH_WORKER_KIND, 'Refreshes Claude OAuth credentials.');
  register(IDLE_TASK_CLEANUP_WORKER_KIND, 'Reports idle tasks.');
  register(REQUEUE_WORKER_KIND, 'Requeues stalled tasks.');
  register('external-preview', 'External preview worker.');

  const runtimeDeps = deps();
  return {
    runtimes,
    logger: runtimeDeps.logger,
    persistence: store,
    controller: createWorkerRuntimeController({
      registry,
      deps: runtimeDeps,
      autoStartKinds,
      persistence: store as never,
      canControl: () => true,
    }),
  };
}

describe('autoStartedOwnerWorkerKindsForConfig', () => {
  it('always-on list is pr-status, claude-oauth-refresh, disk-headroom, autoapprove', () => {
    expect(autoStartedOwnerWorkerKinds()).toEqual([...ALWAYS_AUTO_STARTED_OWNER_WORKER_KINDS]);
    expect(ALWAYS_AUTO_STARTED_OWNER_WORKER_KINDS).toEqual([
      PR_STATUS_WORKER_KIND,
      CLAUDE_OAUTH_REFRESH_WORKER_KIND,
      DISK_HEADROOM_WORKER_KIND,
      AUTO_APPROVE_WORKER_KIND,
    ]);
  });

  it('ignores every legacy config start boolean', () => {
    expect(autoStartedOwnerWorkerKindsForConfig({
      prMaintenance: { enabled: true },
      e2eAutoFixEnabled: true,
      infraRepair: { enabled: true },
      autofix: { enabled: true },
      reaper: { enabled: true },
      workflowResume: { enabled: true },
      requeueEnabled: true,
      slackBugScan: { enabled: true },
      staleTaskCleanup: { enabled: true },
      claudeOauthRefresh: { enabled: false },
      diskHeadroom: { cleanupEnabled: false },
      autoApproveAIFixes: false,
    })).toEqual([...ALWAYS_AUTO_STARTED_OWNER_WORKER_KINDS]);
  });

  it('never auto-starts jailbreak-land or opt-in workers from config', () => {
    expect(autoStartedOwnerWorkerKindsForConfig({})).not.toContain(PR_JAILBREAK_LAND_WORKER_KIND);
    expect(autoStartedOwnerWorkerKindsForConfig({})).not.toContain(PR_ADMIN_BYPASS_LAND_WORKER_KIND);
    expect(autoStartedOwnerWorkerKindsForConfig({})).not.toContain(E2E_AUTOFIX_WORKER_KIND);
    expect(autoStartedOwnerWorkerKindsForConfig({})).not.toContain(INFRA_REPAIR_WORKER_KIND);
  });

  it('PR_MAINTENANCE_AUTO_STARTED_WORKER_KINDS lists the four babysitting kinds', () => {
    expect(PR_MAINTENANCE_AUTO_STARTED_WORKER_KINDS).toEqual([
      PR_ADMIN_BYPASS_LAND_WORKER_KIND,
      PR_ORPHAN_REPAIR_WORKER_KIND,
      PR_DUPLICATE_CLOSE_WORKER_KIND,
      PR_AUTO_LABEL_WORKER_KIND,
    ]);
  });
});

describe('migrateWorkerDesiredStateFromLegacyConfig', () => {
  it('seeds missing desired-state rows from leftover config start flags', () => {
    const store = persistence();
    const seeded = migrateWorkerDesiredStateFromLegacyConfig(store, {
      prMaintenance: { enabled: true },
      e2eAutoFixEnabled: true,
      claudeOauthRefresh: { enabled: false },
    });
    expect(seeded.map((row) => row.workerKind).sort()).toEqual([
      CLAUDE_OAUTH_REFRESH_WORKER_KIND,
      E2E_AUTOFIX_WORKER_KIND,
      ...PR_MAINTENANCE_AUTO_STARTED_WORKER_KINDS,
    ].sort());
    expect(store.setWorkerDesiredState).toHaveBeenCalledWith(PR_ADMIN_BYPASS_LAND_WORKER_KIND, true);
    expect(store.setWorkerDesiredState).toHaveBeenCalledWith(E2E_AUTOFIX_WORKER_KIND, true);
    expect(store.setWorkerDesiredState).toHaveBeenCalledWith(CLAUDE_OAUTH_REFRESH_WORKER_KIND, false);
  });

  it('does not overwrite an existing desired-state row', () => {
    const store = persistence({ [PR_ADMIN_BYPASS_LAND_WORKER_KIND]: false });
    migrateWorkerDesiredStateFromLegacyConfig(store, {
      prMaintenance: { enabled: true },
    });
    expect(store.setWorkerDesiredState).not.toHaveBeenCalledWith(PR_ADMIN_BYPASS_LAND_WORKER_KIND, true);
    expect(store.getWorkerDesiredState(PR_ADMIN_BYPASS_LAND_WORKER_KIND)?.desiredEnabled).toBe(false);
  });

  it('legacy seeds ignore policy flags', () => {
    expect(legacyWorkerStartFlagSeeds({
      autoApproveAIFixes: true,
      diskHeadroom: { cleanupEnabled: true },
    } as never)).toEqual([]);
  });

  it('after migration, flipping a stale config flag does not change auto-start', () => {
    expect(autoStartedOwnerWorkerKindsForConfig({ prMaintenance: { enabled: false } }))
      .toEqual(autoStartedOwnerWorkerKindsForConfig({ prMaintenance: { enabled: true } }));
  });
});

describe('createWorkerRuntimeController', () => {
  it('auto-starts only the code always-on workers', () => {
    const setup = controller();

    setup.controller.startAutoStartedWorkers();
    const snapshot = setup.controller.snapshot();
    const lifecycleByKind = (kind: string) =>
      snapshot.workers.find((worker) => worker.kind === kind)?.lifecycle;

    expect(lifecycleByKind(PR_STATUS_WORKER_KIND)).toBe('running');
    expect(lifecycleByKind(CLAUDE_OAUTH_REFRESH_WORKER_KIND)).toBe('running');
    expect(lifecycleByKind(DISK_HEADROOM_WORKER_KIND)).toBe('running');
    expect(lifecycleByKind(AUTO_APPROVE_WORKER_KIND)).toBe('running');
    expect(lifecycleByKind(PR_ADMIN_BYPASS_LAND_WORKER_KIND)).toBe('stopped');
    expect(lifecycleByKind(PR_ORPHAN_REPAIR_WORKER_KIND)).toBe('stopped');
    expect(lifecycleByKind(WORKFLOW_RESUME_WORKER_KIND)).toBe('stopped');
    expect(lifecycleByKind(AUTO_FIX_WORKER_KIND)).toBe('stopped');
    expect(lifecycleByKind('external-preview')).toBe('stopped');
  });

  it('starts PR-maintenance workers from desired state, not config', () => {
    const desired = Object.fromEntries(
      PR_MAINTENANCE_AUTO_STARTED_WORKER_KINDS.map((kind) => [kind, true]),
    );
    const setup = controller(autoStartedOwnerWorkerKinds(), desired);

    setup.controller.startAutoStartedWorkers();
    const snapshot = setup.controller.snapshot();

    for (const kind of PR_MAINTENANCE_AUTO_STARTED_WORKER_KINDS) {
      expect(snapshot.workers.find((worker) => worker.kind === kind)?.lifecycle).toBe('running');
    }
  });

  it('restores saved desired worker states over built-in launch defaults', () => {
    const setup = controller(autoStartedOwnerWorkerKinds(), {
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

  it('logs persisted worker controls and configured auto-start suppression with their source', async () => {
    const setup = controller([REAPER_WORKER_KIND], { [REAPER_WORKER_KIND]: false });

    setup.controller.startAutoStartedWorkers();
    setup.controller.start(REAPER_WORKER_KIND, { source: 'gui-ipc' });
    await setup.controller.stop(REAPER_WORKER_KIND);

    expect(setup.logger.warn).toHaveBeenCalledWith(
      '[worker-control] configured auto-start suppressed by persisted desired state',
      expect.objectContaining({
        module: 'worker-control',
        workerKind: REAPER_WORKER_KIND,
        configuredAutoStart: true,
        persistedDesiredEnabled: false,
        persistedUpdatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    expect(setup.logger.info).toHaveBeenNthCalledWith(
      1,
      '[worker-control] persisted desired state change',
      expect.objectContaining({
        module: 'worker-control',
        workerKind: REAPER_WORKER_KIND,
        source: 'gui-ipc',
        previousDesiredEnabled: false,
        desiredEnabled: true,
      }),
    );
    expect(setup.logger.info).toHaveBeenNthCalledWith(
      2,
      '[worker-control] persisted desired state change',
      expect.objectContaining({
        module: 'worker-control',
        workerKind: REAPER_WORKER_KIND,
        source: 'controller-api',
        previousDesiredEnabled: true,
        desiredEnabled: false,
      }),
    );
  });

  it('auto-starts e2e-autofix only when its kind is desired-enabled', () => {
    const gated = controller(autoStartedOwnerWorkerKinds(), { [E2E_AUTOFIX_WORKER_KIND]: true });
    gated.controller.startAutoStartedWorkers();
    expect(gated.controller.snapshot().workers.find((worker) => worker.kind === E2E_AUTOFIX_WORKER_KIND)?.lifecycle)
      .toBe('running');

    const ungated = controller();
    ungated.controller.startAutoStartedWorkers();
    const ungatedRow = ungated.controller.snapshot().workers.find((worker) => worker.kind === E2E_AUTOFIX_WORKER_KIND);
    expect(ungatedRow?.lifecycle).toBe('stopped');
    expect(ungatedRow?.startable).toBe(true);
  });

  it('surfaces configured-versus-persisted suppression on status rows', () => {
    const setup = controller([INFRA_REPAIR_WORKER_KIND], { [INFRA_REPAIR_WORKER_KIND]: false });
    setup.controller.startAutoStartedWorkers();
    const row = setup.controller.snapshot().workers.find((worker) => worker.kind === INFRA_REPAIR_WORKER_KIND);
    expect(row).toMatchObject({
      lifecycle: 'stopped',
      configuredAutoStart: true,
      desiredEnabled: false,
      autoStarts: false,
      suppressedByPersistedStop: true,
    });
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

  it('built-in worker policy stays enabled for autofix and the surviving PR-maintenance workers', () => {
    const setup = controller();

    for (const kind of [
      AUTO_FIX_WORKER_KIND,
      PR_ADMIN_BYPASS_LAND_WORKER_KIND,
      PR_ORPHAN_REPAIR_WORKER_KIND,
      PR_DUPLICATE_CLOSE_WORKER_KIND,
      PR_AUTO_LABEL_WORKER_KIND,
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

  it('combines worker action rows and auto-fix task events in recent logs', () => {
    const registry = createWorkerRegistry<WorkerRuntimeDependencies>();
    registry.register({
      kind: AUTO_FIX_WORKER_KIND,
      note: 'Auto-fixes failed tasks.',
      source: 'built-in',
      factory: () => runtime('recovery'),
    });

    const snapshot = createLocalWorkerStatusSnapshot({
      registry,
      autoStartKinds: autoStartedOwnerWorkerKinds(),
      persistence: {
        listWorkerActions: vi.fn(() => [{
          id: 'action-1',
          workerKind: AUTO_FIX_WORKER_KIND,
          actionType: 'fix-with-agent',
          workflowId: 'wf-1',
          taskId: 'wf-1/task-1',
          subjectType: 'task',
          subjectId: 'wf-1/task-1',
          externalKey: 'wf-1/task-1',
          status: 'queued',
          attemptCount: 1,
          payload: { reason: 'failed' },
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:01.000Z',
        }]),
        listTaskEvents: vi.fn(() => [{
          id: 7,
          taskId: 'wf-1/task-1',
          eventType: 'debug.auto-fix',
          payload: '{"phase":"worker-autofix-skip","reason":"not-eligible"}',
          createdAt: '2026-01-01T00:00:02.000Z',
        }]),
        listWorkflows: vi.fn(() => []),
        loadTasks: vi.fn(() => []),
        getEvents: vi.fn(() => []),
        getEventsByTypes: vi.fn(() => []),
        countEventsByTypes: vi.fn(() => []),
      } as never,
    });

    expect(snapshot.workers[0]).toMatchObject({
      source: 'built-in',
      availability: 'available',
    });
    expect(snapshot.workers[0]?.recentLogs).toEqual([
      expect.objectContaining({
        source: 'task_events',
        eventType: 'debug.auto-fix',
        payload: expect.objectContaining({ phase: 'worker-autofix-skip' }),
      }),
      expect.objectContaining({
        source: 'worker_actions',
        actionType: 'fix-with-agent',
        status: 'queued',
      }),
    ]);
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

describe('createOwnerWorkerStatusReader', () => {
  it('keeps the complete last owner snapshot stale through a timeout and replaces it on recovery', async () => {
    const first = ownerSnapshot('2026-01-01T00:00:00.000Z', {
      'pr-status': 'running',
      autofix: 'stopped',
    });
    const recovered = ownerSnapshot('2026-01-01T00:02:00.000Z', {
      'pr-status': 'stopped',
      autofix: 'running',
    });
    const queryOwner = vi.fn()
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error('Owner request timed out'))
      .mockResolvedValueOnce(recovered);
    const now = vi.fn()
      .mockReturnValueOnce('2026-01-01T00:00:01.000Z')
      .mockReturnValueOnce('2026-01-01T00:02:01.000Z');
    const read = createOwnerWorkerStatusReader({
      queryOwner,
      createUnavailableSnapshot: () => ownerSnapshot('2026-01-01T00:01:00.000Z', {
        'pr-status': 'stopped',
        autofix: 'stopped',
      }),
      now,
    });

    await expect(read()).resolves.toEqual({
      ...first,
      authority: 'live',
      lastSuccessfulAt: '2026-01-01T00:00:01.000Z',
    });
    await expect(read()).resolves.toEqual({
      ...first,
      authority: 'cached',
      lastSuccessfulAt: '2026-01-01T00:00:01.000Z',
      unavailableReason: 'Owner request timed out',
    });
    await expect(read()).resolves.toEqual({
      ...recovered,
      authority: 'live',
      lastSuccessfulAt: '2026-01-01T00:02:01.000Z',
    });
  });

  it('marks the local fallback unavailable before any owner response succeeds', async () => {
    const localGuess = ownerSnapshot('2026-01-01T00:00:00.000Z', {
      'pr-status': 'stopped',
      autofix: 'stopped',
    });
    const read = createOwnerWorkerStatusReader({
      queryOwner: vi.fn().mockRejectedValue(new Error('Owner request timed out')),
      createUnavailableSnapshot: () => localGuess,
      now: () => '2026-01-01T00:00:01.000Z',
    });

    await expect(read()).resolves.toEqual({
      generatedAt: localGuess.generatedAt,
      workers: [],
      authority: 'unavailable',
      unavailableReason: 'Owner request timed out',
    });
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
