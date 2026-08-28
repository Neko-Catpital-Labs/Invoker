import { describe, it, expect } from 'vitest';
import {
  PR_ADMIN_BYPASS_LAND_WORKER_KIND,
  PR_ORPHAN_REPAIR_WORKER_KIND,
  WORKER_SESSION_MINE_WORKER_KIND,
  createWorkerRegistry,
  registerBuiltinWorkers,
  type WorkerRuntimeDependencies,
} from '@invoker/execution-engine';
import { resolvePrMaintenanceWorkerConfig, type InvokerConfig } from '../config.js';
import { ALWAYS_AUTO_STARTED_OWNER_WORKER_KINDS, BUILT_IN_WORKER_KINDS } from '../worker-control.js';

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

const emptyStore: WorkerRuntimeDependencies['store'] = {
  listWorkflows: () => [],
  loadTasks: () => [],
  listWorkflowMutationIntents: () => [],
};

const noopSubmitter: WorkerRuntimeDependencies['submitter'] = {
  submit: () => 0,
};

/** Mirror of the owner-startup PR-maintenance dependency construction. */
function buildOwnerWorkerDeps(config: InvokerConfig): WorkerRuntimeDependencies {
  return {
    store: emptyStore,
    submitter: noopSubmitter,
    logger: silentLogger,
    prMaintenance: resolvePrMaintenanceWorkerConfig(config),
  };
}

describe('resolvePrMaintenanceWorkerConfig', () => {
  it('returns undefined when prMaintenance is absent', () => {
    expect(resolvePrMaintenanceWorkerConfig({})).toBeUndefined();
  });

  it('returns launch fields without an enabled gate', () => {
    expect(
      resolvePrMaintenanceWorkerConfig({
        prMaintenance: { repoRoot: '/srv/invoker', intervalMs: 60000 },
      }),
    ).toEqual({ repoRoot: '/srv/invoker', intervalMs: 60000 });
  });

  it('builds the launch config from present fields', () => {
    const resolved = resolvePrMaintenanceWorkerConfig({
      prMaintenance: {
        repoRoot: '/srv/invoker',
        env: { INVOKER_PR_CRON_LOCK: '/tmp/pr.lock' },
        intervalMs: 120000,
        lockPath: '/tmp/pr.lock',
        shell: '/bin/bash',
      },
    });
    expect(resolved).toEqual({
      repoRoot: '/srv/invoker',
      env: { INVOKER_PR_CRON_LOCK: '/tmp/pr.lock' },
      intervalMs: 120000,
      lockPath: '/tmp/pr.lock',
      shell: '/bin/bash',
    });
    expect(resolved).not.toHaveProperty('enabled');
  });

  it('returns an empty launch object when the block has no launch fields', () => {
    expect(resolvePrMaintenanceWorkerConfig({ prMaintenance: {} })).toEqual({});
  });
});

describe('registered owner PR-maintenance worker dependencies', () => {
  it('leaves prMaintenance deps unset when config block is absent', () => {
    expect(buildOwnerWorkerDeps({}).prMaintenance).toBeUndefined();
  });

  it('threads the resolved launch config into owner worker deps', () => {
    const deps = buildOwnerWorkerDeps({
      prMaintenance: { intervalMs: 90000, shell: '/bin/bash' },
    });
    expect(deps.prMaintenance).toEqual({ intervalMs: 90000, shell: '/bin/bash' });
  });

  it('builds the surviving PR-maintenance workers from the owner deps without starting them', () => {
    const registry = registerBuiltinWorkers(createWorkerRegistry<WorkerRuntimeDependencies>());
    const deps = buildOwnerWorkerDeps({
      prMaintenance: { intervalMs: 90000 },
    });

    const adminBypass = registry.get(PR_ADMIN_BYPASS_LAND_WORKER_KIND)?.factory(deps);
    const orphanRepair = registry.get(PR_ORPHAN_REPAIR_WORKER_KIND)?.factory(deps);

    expect(adminBypass?.identity.kind).toBe(PR_ADMIN_BYPASS_LAND_WORKER_KIND);
    expect(adminBypass?.isRunning()).toBe(false);
    expect(orphanRepair?.identity.kind).toBe(PR_ORPHAN_REPAIR_WORKER_KIND);
    expect(orphanRepair?.isRunning()).toBe(false);
  });
});

describe('registered worker-session-mine worker', () => {
  it('registers the off-by-default session miner and builds a stopped runtime', () => {
    const registry = registerBuiltinWorkers(createWorkerRegistry<WorkerRuntimeDependencies>());
    const entry = registry.get(WORKER_SESSION_MINE_WORKER_KIND);
    expect(entry).toBeDefined();

    const runtime = entry!.factory({
      store: emptyStore,
      submitter: noopSubmitter,
      logger: silentLogger,
      workerSessionMine: { intervalMs: 60_000 },
    });
    expect(runtime.identity.kind).toBe(WORKER_SESSION_MINE_WORKER_KIND);
    expect(runtime.isRunning()).toBe(false);
    expect([...ALWAYS_AUTO_STARTED_OWNER_WORKER_KINDS]).not.toContain(WORKER_SESSION_MINE_WORKER_KIND);
    expect(BUILT_IN_WORKER_KINDS.has(WORKER_SESSION_MINE_WORKER_KIND)).toBe(true);
  });
});
