import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAdapter } from '@invoker/data-store';
import type { Workflow } from '@invoker/data-store';
import type { Orchestrator } from '@invoker/workflow-core';
import type { TaskState } from '@invoker/workflow-core';
import { resolveSelectedRemoteTargetId } from '../conflict-resolver.js';
import type { ConflictResolverHost } from '../conflict-resolver.js';

/**
 * Repro for the infra-repair worker's per-tick, per-failed-SSH-task scan:
 * resolveSelectedRemoteTargetId used to fall back to an unbounded
 * getEvents(taskId) full-history scan (no LIMIT) to find the task's last
 * `task.executor.selected` event. On a task with a large accumulated event
 * history (debug/progress logs), that scan alone showed up 1,057 times in a
 * 15-minute DO1 production window, blocking node:sqlite's single-threaded
 * event loop. It must now stay bounded regardless of history size.
 */
describe('resolveSelectedRemoteTargetId bounded event lookup', () => {
  let tmpDir: string | undefined;
  let adapter: SQLiteAdapter | undefined;

  afterEach(async () => {
    await adapter?.close();
    adapter = undefined;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('resolves the latest poolMemberId quickly even with a large unrelated event history', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'invoker-resolve-remote-target-cost-'));
    adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });

    const workflow: Workflow = {
      id: 'wf-1',
      name: 'Test Workflow',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    adapter.saveWorkflow(workflow);
    const task: TaskState = {
      id: 'wf-1/t1',
      description: 'ssh task',
      status: 'failed',
      dependencies: [],
      createdAt: new Date(),
      config: { runnerKind: 'ssh' },
      execution: {},
      taskStateVersion: 1,
    };
    adapter.saveTask('wf-1', task);

    adapter.logEvent('wf-1/t1', 'task.executor.selected', { poolMemberId: 'stale-target' });
    for (let index = 0; index < 20_000; index += 1) {
      adapter.logEvent('wf-1/t1', 'debug.progress', { index });
    }
    adapter.logEvent('wf-1/t1', 'task.executor.selected', { poolMemberId: 'current-target' });

    const host = { persistence: adapter } as unknown as ConflictResolverHost;
    const runnableTask = { ...task, execution: {} } as unknown as ReturnType<Orchestrator['getTask']> & {};

    const startedMs = performance.now();
    const resolved = resolveSelectedRemoteTargetId(host, 'wf-1/t1', runnableTask);
    const elapsedMs = performance.now() - startedMs;

    expect(resolved).toBe('current-target');
    expect(elapsedMs).toBeLessThan(25);
  });
});
