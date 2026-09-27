import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { MetricRegistry } from '../metrics/metric-registry.js';
import { createWorkerRuntime, type WorkerTickContext } from '../worker-runtime.js';
import { REAPER_WORK_KEYS } from '../workers/reaper-worker.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(TEST_DIR, '..');

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() };
}

const BUILTIN_WORKER_SOURCES = [
  'auto-fix-recovery.ts',
  'workers/requeue-worker.ts',
  'workers/workflow-resume-worker.ts',
  'workers/pr-status-worker.ts',
  'workers/infra-repair-worker.ts',
  'workers/disk-headroom-worker.ts',
  'workers/claude-oauth-refresh-worker.ts',
  'workers/reaper-worker.ts',
  'workers/db-reaper-worker.ts',
  'workers/auto-approve-worker.ts',
  'workers/pr-maintenance-workers.ts',
  'workers/e2e-autofix-worker.ts',
  'workers/worker-session-mine-worker.ts',
  'workers/session-token-push-worker.ts',
  'workers/slack-bug-scan-worker.ts',
  'workers/idle-task-cleanup-worker.ts',
  'workers/cross-repo-research-worker.ts',
  'workers/catstack-deploy-worker.ts',
  'workers/self-deploy-worker.ts',
  'workers/admin-bypass-e2e-babysit-worker.ts',
  'workers/mergify-queue-research-worker.ts',
  'workers/spend-circuit-breaker-worker.ts',
  'workers/workflow-cleanup-worker.ts',
  'workers/agent-login-watch-worker.ts',
];

describe('worker keys migration', () => {
  it('collapses repeated task ids to one queued WorkQueue key', async () => {
    const registry = new MetricRegistry();
    const contexts: WorkerTickContext[] = [];
    const runtime = createWorkerRuntime({
      kind: 'worker-key-migration',
      logger: makeLogger(),
      intervalMs: 0,
      tickOnStart: false,
      installSignalHandlers: false,
      workQueueRegistry: registry,
      workQueueName: 'worker-key-migration',
      listWorkKeys: () => ['task-1', 'task-1'],
      onTick: (ctx) => {
        contexts.push(ctx);
      },
    });

    await runtime.tick('manual');

    expect(contexts.map((ctx) => ctx.workKey)).toEqual(['task-1']);
    expect(registry.getValue('workqueue_adds_total', { name: 'worker-key-migration' })).toBe(1);
    expect(registry.getValue('workqueue_completeness', { name: 'worker-key-migration', state: 'complete' })).toBe(1);
  });

  it('keeps every built-in worker off the synthetic runtime bridge', () => {
    for (const relativePath of BUILTIN_WORKER_SOURCES) {
      const source = readFileSync(resolve(SRC_DIR, relativePath), 'utf8');
      expect(source, `${relativePath} should declare WorkQueue keys`).toContain('listWorkKeys');
    }
  });

  it('keeps the reaper migration on its six phase keys', () => {
    expect(REAPER_WORK_KEYS).toEqual([
      'reaper:orphans',
      'reaper:checkouts',
      'reaper:temp-dirs',
      'reaper:snapshots-artifacts',
      'reaper:worktrees',
      'reaper:development-homes',
    ]);
  });
});
