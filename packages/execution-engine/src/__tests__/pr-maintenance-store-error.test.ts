import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkerActionWrite } from '@invoker/data-store';

import { createPrAdminBypassLandWorker } from '../workers/pr-maintenance-workers.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRepoRoot(): { repoRoot: string; ledger: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'pr-maint-store-error-'));
  roots.push(repoRoot);
  mkdirSync(join(repoRoot, 'scripts'));
  writeFileSync(join(repoRoot, 'scripts', 'cron-pr-admin-bypass-land.sh'), 'exit 0\n');
  const ledger = join(repoRoot, 'ledger.jsonl');
  writeFileSync(ledger, `${JSON.stringify({ kind: 'comment-blocked', pr: 101, headSha: 'abc123', key: 'capped', epoch: 1 })}\n`);
  return { repoRoot, ledger };
}

describe('PR maintenance tick when a store write fails', () => {
  it('settles the tick and lets the next tick run when recording blocked-PR rows throws', async () => {
    const { repoRoot, ledger } = makeRepoRoot();
    let failBlockedRows = true;
    const store = {
      getWorkerAction: vi.fn(() => undefined),
      upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
        if (failBlockedRows && write.actionType === 'mergify-blocked-pr') {
          throw new Error('database or disk is full');
        }
        return { ...write, attemptCount: 0, id: 'x', createdAt: 'now', updatedAt: 'now' };
      }),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
    const worker = createPrAdminBypassLandWorker({
      logger: logger as never,
      repoRoot,
      lockProbe: () => ({ held: false }),
      installSignalHandlers: false,
      store: store as never,
      env: { INVOKER_MERGIFY_ADMIN_REQUEUE_STATE_FILE: ledger },
    });

    const first = await Promise.race([
      worker.tick().then(() => 'settled', () => 'settled'),
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout('hung'), 5000)),
    ]);
    expect(first).toBe('settled');
    expect(logger.error).toHaveBeenCalledWith(
      '[worker:pr-admin-bypass-land] failed while finishing tick',
      expect.objectContaining({ worker: 'pr-admin-bypass-land' }),
    );

    failBlockedRows = false;
    const upsertsBefore = store.upsertWorkerAction.mock.calls.length;
    const second = await Promise.race([
      worker.tick().then(() => 'settled', () => 'settled'),
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout('hung'), 5000)),
    ]);
    expect(second).toBe('settled');
    const secondRunStatuses = store.upsertWorkerAction.mock.calls
      .slice(upsertsBefore)
      .filter((call) => call[0].actionType === 'pr-maintenance-run')
      .map((call) => call[0].status);
    expect(secondRunStatuses).toEqual(['running', 'completed']);
  }, 20000);
});
