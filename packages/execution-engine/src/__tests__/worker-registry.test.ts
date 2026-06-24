import { describe, it, expect } from 'vitest';

import { RECOVERY_WORKER_KIND, type AutoFixRecoveryStore, type AutoFixRecoverySubmitter } from '../auto-fix-recovery.js';
import {
  AUTO_FIX_WORKER_KIND,
  createWorkerRegistry,
  registerAutoFixWorker,
  type WorkerRuntimeDependencies,
} from '../worker-registry.js';

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

const emptyStore: AutoFixRecoveryStore = {
  listWorkflows: () => [],
  loadTasks: () => [],
  listWorkflowMutationIntents: () => [],
};

const noopSubmitter: AutoFixRecoverySubmitter = {
  submit: () => 0,
};

function deps(): WorkerRuntimeDependencies {
  return { store: emptyStore, submitter: noopSubmitter, logger: silentLogger };
}

describe('worker registry', () => {
  it('starts empty before anything is registered', () => {
    const registry = createWorkerRegistry();
    expect(registry.list()).toEqual([]);
    expect(registry.get(AUTO_FIX_WORKER_KIND)).toBeUndefined();
  });

  it('returns the auto-fix definition by its kind once registered', () => {
    const registry = registerAutoFixWorker(createWorkerRegistry());

    const definition = registry.get(AUTO_FIX_WORKER_KIND);
    expect(definition).toBeDefined();
    expect(definition?.kind).toBe(AUTO_FIX_WORKER_KIND);
    expect(definition?.note.length).toBeGreaterThan(0);
    expect(typeof definition?.factory).toBe('function');

    expect(registry.list().map((d) => d.kind)).toEqual([AUTO_FIX_WORKER_KIND]);
  });

  it('returns nothing for an unknown kind', () => {
    const registry = registerAutoFixWorker(createWorkerRegistry());
    expect(registry.get('does-not-exist')).toBeUndefined();
  });

  it('builds a recovery worker runtime from the auto-fix factory', () => {
    const registry = registerAutoFixWorker(createWorkerRegistry());
    const definition = registry.get(AUTO_FIX_WORKER_KIND);
    expect(definition).toBeDefined();

    const runtime = definition!.factory(deps());
    // The registry kind is `autofix`, but it reuses the recovery worker, whose
    // runtime identity keeps the underlying recovery kind.
    expect(runtime.identity.kind).toBe(RECOVERY_WORKER_KIND);
    expect(runtime.isRunning()).toBe(false);
  });
});
