import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalBus } from '@invoker/transport';

import { runHeadless, type HeadlessDeps } from '../headless.js';
import { recordRecoveryWorkerStatus } from '../recovery-worker-observability.js';

const here = dirname(fileURLToPath(import.meta.url));
const originalInvokerDbDir = process.env.INVOKER_DB_DIR;

describe('headless auto-fix ownership', () => {
  afterEach(() => {
    if (originalInvokerDbDir === undefined) {
      delete process.env.INVOKER_DB_DIR;
    } else {
      process.env.INVOKER_DB_DIR = originalInvokerDbDir;
    }
    vi.restoreAllMocks();
  });

  it('does not wire hidden auto-fix subscriptions in normal headless commands', async () => {
    const source = await readFile(resolve(here, '../headless.ts'), 'utf8');

    expect(source).not.toContain('wireHeadlessAutoFix');
  });

  it('reports worker ownership and skipped auto-fix decisions', async () => {
    const invokerHomeRoot = mkdtempSync(join(tmpdir(), 'invoker-headless-autofix-'));
    process.env.INVOKER_DB_DIR = invokerHomeRoot;
    recordRecoveryWorkerStatus({
      kind: 'recovery',
      command: 'autofix',
      instanceId: 'recovery-test-1',
      ownerId: 'owner-test',
      pid: 123,
      state: 'running',
      intervalMs: 60000,
      tickCount: 2,
      wakeCount: 1,
      lastScanAt: '2026-06-21T10:00:00.000Z',
      lastScanReason: 'poll',
      lastWakeupAt: '2026-06-21T09:59:00.000Z',
      lastWakeupReason: 'wake',
      updatedAt: '2026-06-21T10:00:00.000Z',
    });

    const deps = {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
      orchestrator: {},
      persistence: {
        listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
        loadTasks: vi.fn(() => [{ id: 'wf-1/task-a' }]),
        getEvents: vi.fn(() => [
          {
            id: 1,
            taskId: 'wf-1/task-a',
            eventType: 'debug.auto-fix',
            payload: JSON.stringify({ phase: 'schedule-skip', reason: 'shouldAutoFix-false' }),
            createdAt: '2026-06-21T10:01:00.000Z',
          },
          {
            id: 2,
            taskId: 'wf-1/task-a',
            eventType: 'debug.auto-fix',
            payload: JSON.stringify({ phase: 'schedule-enqueued' }),
            createdAt: '2026-06-21T10:02:00.000Z',
          },
        ]),
      },
      commandService: {},
      executorRegistry: {},
      messageBus: new LocalBus(),
      repoRoot: '/tmp/repo',
      invokerConfig: {},
      initServices: vi.fn(async () => {}),
      wireSlackBot: vi.fn(async () => ({})),
    } as unknown as HeadlessDeps;
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runHeadless(['query', 'recovery-worker', '--output', 'json'], deps);

    const parsed = JSON.parse(stdout.mock.calls[0][0] as string);
    expect(parsed.workers[0]).toMatchObject({
      instanceId: 'recovery-test-1',
      ownerId: 'owner-test',
      lastScanReason: 'poll',
      lastWakeupReason: 'wake',
    });
    expect(parsed.lastSkip).toMatchObject({
      taskId: 'wf-1/task-a',
      phase: 'schedule-skip',
      reason: 'shouldAutoFix-false',
    });
    expect(parsed.lastSubmit).toMatchObject({
      taskId: 'wf-1/task-a',
      phase: 'schedule-enqueued',
    });
    rmSync(invokerHomeRoot, { recursive: true, force: true });
  });
});
