/**
 * REPRO — "Application quit" mislabels infra crashes (Issues 1 & 2)
 *
 * Claim being proven:
 *   Tasks orphaned by an owner crash are force-failed with the hard-coded
 *   reason "Application quit", clobbering any real (e.g. SSH/OAuth infra)
 *   failure context when callers pass no `reason`; boot call sites must pass
 *   the owner-restart reason instead.
 *
 * This exercises the REAL production code:
 *   - reconcileOrphanedInFlightTasksOnBoot / isTaskInFlightForForcedStop
 *   - the two call sites in main.ts (read as source, asserted to pass a reason)
 *
 * Run: packages/app/node_modules/.bin/vitest run src/__tests__/repro-orphan-application-quit-mislabel.test.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';

import {
  isTaskInFlightForForcedStop,
  reconcileOrphanedInFlightTasksOnBoot,
} from '../reconcile-orphaned-running-tasks.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const reconcileSrc = readFileSync(path.join(here, '../reconcile-orphaned-running-tasks.ts'), 'utf8');
const mainSrc = readFileSync(path.join(here, '../main.ts'), 'utf8');

function makeTask(
  id: string,
  status: TaskState['status'],
  execution: TaskState['execution'] = {},
): TaskState {
  return {
    id,
    description: id,
    status,
    dependencies: [],
    createdAt: new Date('2026-08-02T01:40:00.000Z'),
    config: { workflowId: 'wf-1', runnerKind: 'ssh' },
    execution: { generation: 3, selectedAttemptId: 'attempt-1', ...execution },
    taskStateVersion: 1,
  } as TaskState;
}

describe('REPRO Issue 1: orphan-reconcile clobbers the real infra failure with "Application quit"', () => {
  it('overwrites a genuine SSH/OAuth error on a launching task with the generic reason', () => {
    // Mirror the real orphans from 2026-08-02 01:40: SSH tasks stuck in
    // `launching` (heartbeat == launchStartedAt) with a real infra cause.
    const sshStuck = makeTask('wf-6976/repair', 'running', {
      phase: 'launching',
      error: 'SSH execution-pool infra failure: OAuth session expired and could not be refreshed',
    });
    const pendingLaunching = makeTask('wf-6976/normalize', 'pending', { phase: 'launching' });

    const captured: Array<{ actionId: string; error: string; exitCode: number }> = [];
    const appendTaskOutput = vi.fn();

    const failed = reconcileOrphanedInFlightTasksOnBoot({
      orchestrator: {
        getAllTasks: () => [sshStuck, pendingLaunching],
        handleWorkerResponse: (r: {
          actionId: string;
          outputs: { exitCode: number; error: string };
        }) => {
          captured.push({ actionId: r.actionId, error: r.outputs.error, exitCode: r.outputs.exitCode });
        },
      },
      persistence: { getOutputTail: () => [], appendTaskOutput },
    });

    // Both in-flight tasks were swept.
    expect(failed.map(t => t.id).sort()).toEqual(['wf-6976/normalize', 'wf-6976/repair']);

    // BUG (coarse field): every task — including the one that carried a real
    // SSH/OAuth cause — is reported to the orchestrator as the generic
    // "Application quit", exit 1. This is the field `query tasks`, dashboards,
    // and the admin-bypass classifier read.
    for (const c of captured) {
      expect(c.error).toBe('Application quit');
      expect(c.exitCode).toBe(1);
    }

    // Per-task durable diagnostics: the tail preserves a pre-existing
    // execution.error via an `error=` line — BUT the real launching-orphans in
    // the incident never had one set (they died mid-launch), so their cause is
    // genuinely lost, leaving only the generic forcedStopReason.
    const diagByTask = new Map<string, string>();
    for (const [taskId, data] of appendTaskOutput.mock.calls as Array<[string, string]>) {
      diagByTask.set(taskId, String(data ?? ''));
    }

    // Real incident shape: launching orphan with no pre-set error → cause lost.
    const orphanDiag = diagByTask.get('wf-6976/normalize') ?? '';
    expect(orphanDiag).toContain('forcedStopReason=Application quit');
    expect(orphanDiag).not.toContain('OAuth session expired');
    expect(orphanDiag).not.toMatch(/\berror=/);
  });

  it('the default reason literal is "Application quit" (source of the label)', () => {
    expect(reconcileSrc).toMatch(/const reason = options\.reason \?\? 'Application quit';/);
  });

  it('launching pending/queued and running tasks are treated as in-flight (so infra-stuck tasks get swept)', () => {
    expect(isTaskInFlightForForcedStop(makeTask('a', 'running'))).toBe(true);
    expect(isTaskInFlightForForcedStop(makeTask('b', 'pending', { phase: 'launching' }))).toBe(true);
    expect(isTaskInFlightForForcedStop(makeTask('c', 'queued' as TaskState['status'], { phase: 'launching' }))).toBe(true);
  });
});

describe('REPRO Issue 2: the boot call sites pass the owner-restart reason', () => {
  it('every reconcileOrphanedInFlightTasksOnBoot(...) call in main.ts passes OWNER_RESTART_REASON', () => {
    const calls = [...mainSrc.matchAll(/reconcileOrphanedInFlightTasksOnBoot\(\{([\s\S]*?)\}\)/g)];
    // Both known boot paths (headless owner + GUI owner) call it.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const m of calls) {
      expect(m[1]).toMatch(/\breason\b\s*:\s*OWNER_RESTART_REASON/);
    }
  });

  it('the crash reconcile is logged as "previous owner crash" — not a graceful quit', () => {
    expect(mainSrc).toContain('orphaned in-flight task(s) left by a previous owner crash');
  });
});
