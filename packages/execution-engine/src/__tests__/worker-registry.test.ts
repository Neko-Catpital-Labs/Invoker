import { describe, it, expect } from 'vitest';

import {
  AUTO_FIX_WORKER_KIND,
  RECOVERY_WORKER_KIND,
  registerAutoFixWorker,
  type AutoFixRecoveryStore,
  type AutoFixRecoverySubmitter,
} from '../auto-fix-recovery.js';
import { registerBuiltinWorkers } from '../builtin-workers.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import { createWorkerRegistry } from '../worker-registry.js';
import { CI_FAILURE_WORKER_KIND } from '../workers/ci-failure-worker.js';
import { AUTO_APPROVE_WORKER_KIND } from '../workers/auto-approve-worker.js';
import {
  CODERABBIT_ADDRESS_WORKER_KIND,
  PR_CONFLICT_REBASE_WORKER_KIND,
} from '../workers/pr-maintenance-workers.js';
import { PR_STATUS_WORKER_KIND } from '../workers/pr-status-worker.js';
import { PR_SUMMARY_REFRESH_WORKER_KIND } from '../workers/pr-summary-refresh-worker.js';
import { DISK_HEADROOM_WORKER_KIND } from '../workers/disk-headroom-worker.js';
import { REQUEUE_WORKER_KIND } from '../workers/requeue-worker.js';
import { REVIEW_GATE_MERGE_CONFLICT_WORKER_KIND } from '../workers/review-gate-merge-conflict-worker.js';
import { WORKFLOW_RESUME_WORKER_KIND } from '../workers/workflow-resume-worker.js';
import { E2E_AUTOFIX_WORKER_KIND } from '../workers/e2e-autofix-worker.js';

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
    const registry = createWorkerRegistry<WorkerRuntimeDependencies>();
    expect(registry.list()).toEqual([]);
    expect(registry.get(AUTO_FIX_WORKER_KIND)).toBeUndefined();
  });

  it('returns the auto-fix definition by its kind once registered', () => {
    const registry = registerAutoFixWorker(createWorkerRegistry<WorkerRuntimeDependencies>());

    const definition = registry.get(AUTO_FIX_WORKER_KIND);
    expect(definition).toBeDefined();
    expect(definition?.kind).toBe(AUTO_FIX_WORKER_KIND);
    expect(definition?.note.length).toBeGreaterThan(0);
    expect(typeof definition?.factory).toBe('function');

    expect(registry.list().map((d) => d.kind)).toEqual([AUTO_FIX_WORKER_KIND]);
  });

  it('registers every built-in worker in one call', () => {
    const registry = registerBuiltinWorkers(createWorkerRegistry<WorkerRuntimeDependencies>());

    expect(registry.list().map((d) => d.kind)).toEqual([
      AUTO_FIX_WORKER_KIND,
      REQUEUE_WORKER_KIND,
      WORKFLOW_RESUME_WORKER_KIND,
      PR_STATUS_WORKER_KIND,
      PR_SUMMARY_REFRESH_WORKER_KIND,
      CI_FAILURE_WORKER_KIND,
      REVIEW_GATE_MERGE_CONFLICT_WORKER_KIND,
      DISK_HEADROOM_WORKER_KIND,
      AUTO_APPROVE_WORKER_KIND,
      CODERABBIT_ADDRESS_WORKER_KIND,
      PR_CONFLICT_REBASE_WORKER_KIND,
      E2E_AUTOFIX_WORKER_KIND,
    ]);
    expect(registry.get(AUTO_FIX_WORKER_KIND)).toBeDefined();
    expect(registry.get(REQUEUE_WORKER_KIND)).toBeDefined();
    expect(registry.get(WORKFLOW_RESUME_WORKER_KIND)).toBeDefined();
    expect(registry.get(PR_STATUS_WORKER_KIND)).toBeDefined();
    expect(registry.get(PR_SUMMARY_REFRESH_WORKER_KIND)).toBeDefined();
    expect(registry.get(CI_FAILURE_WORKER_KIND)).toBeDefined();
    expect(registry.get(REVIEW_GATE_MERGE_CONFLICT_WORKER_KIND)).toBeDefined();
    expect(registry.get(DISK_HEADROOM_WORKER_KIND)).toBeDefined();
    expect(registry.get(AUTO_APPROVE_WORKER_KIND)).toBeDefined();
    expect(registry.get(CODERABBIT_ADDRESS_WORKER_KIND)).toBeDefined();
    expect(registry.get(PR_CONFLICT_REBASE_WORKER_KIND)).toBeDefined();
    expect(registry.get(E2E_AUTOFIX_WORKER_KIND)).toBeDefined();
  });
  it('returns nothing for an unknown kind', () => {
    const registry = registerAutoFixWorker(createWorkerRegistry<WorkerRuntimeDependencies>());
    expect(registry.get('does-not-exist')).toBeUndefined();
  });

  it('builds a recovery worker runtime from the auto-fix factory', () => {
    const registry = registerAutoFixWorker(createWorkerRegistry<WorkerRuntimeDependencies>());
    const definition = registry.get(AUTO_FIX_WORKER_KIND);
    expect(definition).toBeDefined();

    const runtime = definition!.factory(deps());
    // The registry kind is `autofix`, but it reuses the recovery worker, whose
    // runtime identity keeps the underlying recovery kind.
    expect(runtime.identity.kind).toBe(RECOVERY_WORKER_KIND);
    expect(runtime.isRunning()).toBe(false);
  });


  it('builds the PR status and CI-failure worker runtimes from the registered factories', () => {
    const registry = registerBuiltinWorkers(createWorkerRegistry<WorkerRuntimeDependencies>());

    expect(registry.get(PR_STATUS_WORKER_KIND)?.factory(deps()).identity.kind).toBe(PR_STATUS_WORKER_KIND);
    expect(registry.get(PR_SUMMARY_REFRESH_WORKER_KIND)?.factory(deps()).identity.kind)
      .toBe(PR_SUMMARY_REFRESH_WORKER_KIND);
    expect(registry.get(CI_FAILURE_WORKER_KIND)?.factory(deps()).identity.kind).toBe(CI_FAILURE_WORKER_KIND);
    expect(registry.get(CODERABBIT_ADDRESS_WORKER_KIND)?.factory(deps()).identity.kind)
      .toBe(CODERABBIT_ADDRESS_WORKER_KIND);
    expect(registry.get(PR_CONFLICT_REBASE_WORKER_KIND)?.factory(deps()).identity.kind)
      .toBe(PR_CONFLICT_REBASE_WORKER_KIND);
  });
});
