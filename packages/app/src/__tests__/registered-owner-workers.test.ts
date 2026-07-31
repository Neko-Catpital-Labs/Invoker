import { describe, it, expect } from 'vitest';
import {
  PR_ADMIN_BYPASS_LAND_WORKER_KIND,
  PR_ADMIN_BYPASS_QUEUE_WORKER_KIND,
  PR_ORPHAN_REPAIR_WORKER_KIND,
  createWorkerRegistry,
  registerBuiltinWorkers,
  type WorkerRuntimeDependencies,
} from '@invoker/execution-engine';
import { resolvePrMaintenanceWorkerConfig, type InvokerConfig } from '../config.js';

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
  it('returns undefined when prMaintenance is absent (disabled by default)', () => {
    expect(resolvePrMaintenanceWorkerConfig({})).toBeUndefined();
  });

  it('returns undefined when prMaintenance is present but not enabled', () => {
    expect(
      resolvePrMaintenanceWorkerConfig({
        prMaintenance: { repoRoot: '/srv/invoker', intervalMs: 60000 },
      }),
    ).toBeUndefined();
    expect(
      resolvePrMaintenanceWorkerConfig({
        prMaintenance: { enabled: false, repoRoot: '/srv/invoker' },
      }),
    ).toBeUndefined();
  });

  it('builds the launch config and drops the enabled gate when enabled', () => {
    const resolved = resolvePrMaintenanceWorkerConfig({
      prMaintenance: {
        enabled: true,
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

  it('omits unset launch fields', () => {
    expect(
      resolvePrMaintenanceWorkerConfig({
        prMaintenance: { enabled: true, repoRoot: '/srv/invoker' },
      }),
    ).toEqual({ repoRoot: '/srv/invoker' });
  });
});

describe('registered owner PR-maintenance worker dependencies', () => {
  it('leaves prMaintenance deps unset when config is disabled', () => {
    expect(buildOwnerWorkerDeps({}).prMaintenance).toBeUndefined();
  });

  it('threads the resolved launch config into owner worker deps when enabled', () => {
    const deps = buildOwnerWorkerDeps({
      prMaintenance: { enabled: true, intervalMs: 90000, shell: '/bin/bash' },
    });
    expect(deps.prMaintenance).toEqual({ intervalMs: 90000, shell: '/bin/bash' });
  });

  it('builds the surviving PR-maintenance workers from the owner deps without starting them', () => {
    const registry = registerBuiltinWorkers(createWorkerRegistry<WorkerRuntimeDependencies>());
    const deps = buildOwnerWorkerDeps({
      prMaintenance: { enabled: true, intervalMs: 90000 },
    });

    const adminBypass = registry.get(PR_ADMIN_BYPASS_LAND_WORKER_KIND)?.factory(deps);
    const adminBypassQueue = registry.get(PR_ADMIN_BYPASS_QUEUE_WORKER_KIND)?.factory(deps);
    const orphanRepair = registry.get(PR_ORPHAN_REPAIR_WORKER_KIND)?.factory(deps);

    expect(adminBypass?.identity.kind).toBe(PR_ADMIN_BYPASS_LAND_WORKER_KIND);
    expect(adminBypass?.isRunning()).toBe(false);
    expect(adminBypassQueue?.identity.kind).toBe(PR_ADMIN_BYPASS_QUEUE_WORKER_KIND);
    expect(adminBypassQueue?.isRunning()).toBe(false);
    expect(orphanRepair?.identity.kind).toBe(PR_ORPHAN_REPAIR_WORKER_KIND);
    expect(orphanRepair?.isRunning()).toBe(false);
  });
});
