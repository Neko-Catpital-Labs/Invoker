import { describe, expect, it } from 'vitest';

import {
  CODERABBIT_ADDRESS_WORKER_KIND,
  PR_CONFLICT_REBASE_WORKER_KIND,
  createWorkerRegistry,
  registerBuiltinWorkers,
  type WorkerRuntimeDependencies,
} from '@invoker/execution-engine';
import type { Logger } from '@invoker/contracts';

import {
  resolveRegisteredOwnerPrMaintenanceConfig,
  type InvokerConfig,
} from '../config.js';

const silentLogger: Logger = {
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

function buildOwnerDeps(config: InvokerConfig): WorkerRuntimeDependencies {
  return {
    store: emptyStore,
    submitter: noopSubmitter,
    logger: silentLogger,
    prMaintenance: resolveRegisteredOwnerPrMaintenanceConfig(config),
  };
}

describe('registered owner PR-maintenance workers', () => {
  it('keeps owner PR-maintenance config disabled by default', () => {
    expect(resolveRegisteredOwnerPrMaintenanceConfig({})).toBeUndefined();
    expect(resolveRegisteredOwnerPrMaintenanceConfig({
      prMaintenance: {
        enabled: false,
        repoRoot: '/srv/invoker',
        intervalMs: 120_000,
      },
    })).toBeUndefined();
    expect(resolveRegisteredOwnerPrMaintenanceConfig({
      prMaintenance: {
        enabled: true,
        repoRoot: '/srv/invoker',
        intervalMs: 120_000,
        lockPath: '/tmp/pr-maintenance.lock',
        shell: '/bin/zsh',
        env: {
          INVOKER_PR_TARGET: 'open',
        },
      },
    })).toEqual({
      repoRoot: '/srv/invoker',
      intervalMs: 120_000,
      lockPath: '/tmp/pr-maintenance.lock',
      shell: '/bin/zsh',
      env: {
        INVOKER_PR_TARGET: 'open',
      },
    });
  });

  it('threads enabled owner config into registered PR-maintenance worker factories', () => {
    const registry = registerBuiltinWorkers(createWorkerRegistry<WorkerRuntimeDependencies>());
    const deps = buildOwnerDeps({
      prMaintenance: {
        enabled: true,
        repoRoot: '/srv/invoker',
        intervalMs: 120_000,
        lockPath: '/tmp/pr-maintenance.lock',
      },
    });

    expect(deps.prMaintenance).toEqual({
      repoRoot: '/srv/invoker',
      intervalMs: 120_000,
      lockPath: '/tmp/pr-maintenance.lock',
    });
    expect(registry.get(CODERABBIT_ADDRESS_WORKER_KIND)?.factory(deps).identity.kind)
      .toBe(CODERABBIT_ADDRESS_WORKER_KIND);
    expect(registry.get(PR_CONFLICT_REBASE_WORKER_KIND)?.factory(deps).identity.kind)
      .toBe(PR_CONFLICT_REBASE_WORKER_KIND);
  });
});
