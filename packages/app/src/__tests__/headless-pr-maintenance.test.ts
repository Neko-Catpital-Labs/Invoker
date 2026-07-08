import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@invoker/contracts';
import type { SQLiteAdapter } from '@invoker/data-store';
import {
  AUTO_FIX_WORKER_KIND,
  CODERABBIT_ADDRESS_WORKER_KIND,
  PR_CONFLICT_REBASE_WORKER_KIND,
} from '@invoker/execution-engine';

import {
  createHeadlessWorkerRegistry,
  createHeadlessWorkerRuntimeDeps,
} from '../headless.js';
import { resolvePrMaintenanceWorkerConfig, type InvokerConfig } from '../config.js';

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

// The runtime-deps builder only forwards the adapter as the worker `store` and
// captures `enqueueWorkflowMutationIntent` inside a closure — neither is invoked
// unless a worker actually ticks, which these construction tests never do.
const persistenceStub = {
  enqueueWorkflowMutationIntent: vi.fn(() => 0),
  listWorkflows: () => [],
  loadTasks: () => [],
  listWorkflowMutationIntents: () => [],
} as unknown as SQLiteAdapter;

function runtimeDeps(config: InvokerConfig) {
  return createHeadlessWorkerRuntimeDeps({
    persistence: persistenceStub,
    logger: silentLogger,
    invokerConfig: config,
  });
}

describe('createHeadlessWorkerRegistry', () => {
  it('exposes the PR-maintenance worker kinds for manual one-shot runs', () => {
    const registry = createHeadlessWorkerRegistry(undefined);

    expect(registry.get(CODERABBIT_ADDRESS_WORKER_KIND)?.kind).toBe(CODERABBIT_ADDRESS_WORKER_KIND);
    expect(registry.get(PR_CONFLICT_REBASE_WORKER_KIND)?.kind).toBe(PR_CONFLICT_REBASE_WORKER_KIND);
    // Auto-fix stays available alongside the PR-maintenance kinds.
    expect(registry.get(AUTO_FIX_WORKER_KIND)?.kind).toBe(AUTO_FIX_WORKER_KIND);
  });
});

describe('createHeadlessWorkerRuntimeDeps', () => {
  it('threads the resolved prMaintenance launch config when enabled', () => {
    const config: InvokerConfig = {
      prMaintenance: { enabled: true, intervalMs: 90000, shell: '/bin/bash' },
    };

    const deps = runtimeDeps(config);

    // Same resolution owner startup uses: the `enabled` gate is dropped and only
    // the launch fields survive.
    expect(deps.prMaintenance).toEqual(resolvePrMaintenanceWorkerConfig(config));
    expect(deps.prMaintenance).toEqual({ intervalMs: 90000, shell: '/bin/bash' });
  });

  it('leaves prMaintenance unset when config is disabled', () => {
    expect(runtimeDeps({}).prMaintenance).toBeUndefined();
    expect(runtimeDeps({ prMaintenance: { intervalMs: 90000 } }).prMaintenance).toBeUndefined();
  });
});

describe('headless PR-maintenance one-shot construction', () => {
  it('constructs both PR-maintenance workers from the entrypoint without starting them', () => {
    const registry = createHeadlessWorkerRegistry(undefined);
    const deps = runtimeDeps({ prMaintenance: { enabled: true, intervalMs: 90000 } });

    const coderabbit = registry.get(CODERABBIT_ADDRESS_WORKER_KIND)?.factory(deps);
    const rebase = registry.get(PR_CONFLICT_REBASE_WORKER_KIND)?.factory(deps);

    expect(coderabbit?.identity.kind).toBe(CODERABBIT_ADDRESS_WORKER_KIND);
    expect(coderabbit?.isRunning()).toBe(false);
    expect(rebase?.identity.kind).toBe(PR_CONFLICT_REBASE_WORKER_KIND);
    expect(rebase?.isRunning()).toBe(false);
  });
});
