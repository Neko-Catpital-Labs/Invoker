import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import { createAttempt, createTaskState } from '@invoker/workflow-core';

describe('Attempt persistence', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    // Create a workflow and task so FK constraints pass
    adapter.saveWorkflow({ id: 'wf-1', name: 'Test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), });
    const task = createTaskState('taskA', 'Task A', [], { workflowId: 'wf-1' });
    adapter.saveTask('wf-1', task);
  });

  afterEach(() => {
    adapter.close();
  });

  it('round-trip: saveAttempt + loadAttempt', () => {
    const attempt = createAttempt('taskA', {
      status: 'running',
      snapshotCommit: 'abc123',
      baseBranch: 'main',
      upstreamAttemptIds: ['dep-a1'],
      commandOverride: 'pnpm test --watch',
      startedAt: new Date('2024-01-01T00:00:00Z'),
      branch: 'invoker/taskA-a1',
    });

    adapter.saveAttempt(attempt);
    const loaded = adapter.loadAttempt(attempt.id);

    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe(attempt.id);
    expect(loaded!.nodeId).toBe('taskA');
    expect(loaded!.status).toBe('running');
    expect(loaded!.snapshotCommit).toBe('abc123');
    expect(loaded!.baseBranch).toBe('main');
    expect(loaded!.upstreamAttemptIds).toEqual(['dep-a1']);
    expect(loaded!.commandOverride).toBe('pnpm test --watch');
    expect(loaded!.startedAt).toEqual(new Date('2024-01-01T00:00:00Z'));
    expect(loaded!.branch).toBe('invoker/taskA-a1');
    expect(loaded!.createdAt).toBeInstanceOf(Date);
  });

  it('loadAttempts returns ordered by created_at', () => {
    const a1 = createAttempt('taskA', { status: 'completed' });
    // Ensure distinct created_at by bumping time
    const a2 = createAttempt('taskA', { status: 'superseded', createdAt: new Date(Date.now() + 1000) } as any);
    const a3 = createAttempt('taskA', { status: 'pending', createdAt: new Date(Date.now() + 2000) } as any);

    adapter.saveAttempt(a3);
    adapter.saveAttempt(a1);
    adapter.saveAttempt(a2);

    const attempts = adapter.loadAttempts('taskA');
    expect(attempts).toHaveLength(3);
    // Should be ordered by created_at ASC
    expect(attempts[0].id).toBe(a1.id);
    expect(attempts[1].id).toBe(a2.id);
    expect(attempts[2].id).toBe(a3.id);
  });

  it('loadCostAttributionAttempts projects only attribution columns in created_at order', () => {
    const older = {
      ...createAttempt('taskA', {
        status: 'failed',
        agentSessionId: 'sess-old',
        error: 'x'.repeat(100_000),
      }),
      id: 'attempt-old',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    };
    const newer = {
      ...createAttempt('taskA', {
        status: 'completed',
        agentSessionId: 'sess-new',
        error: 'y'.repeat(100_000),
      }),
      id: 'attempt-new',
      createdAt: new Date('2026-07-01T00:01:00.000Z'),
    };
    adapter.saveAttempt(newer);
    adapter.saveAttempt(older);

    const queryAll = vi.spyOn(
      adapter as unknown as { queryAll: (sql: string, params?: unknown[]) => Record<string, unknown>[] },
      'queryAll',
    );
    let sql = '';
    try {
      expect(adapter.loadCostAttributionAttempts('taskA')).toEqual([
        {
          id: 'attempt-old',
          nodeId: 'taskA',
          agentSessionId: 'sess-old',
          createdAt: new Date('2026-07-01T00:00:00.000Z'),
        },
        {
          id: 'attempt-new',
          nodeId: 'taskA',
          agentSessionId: 'sess-new',
          createdAt: new Date('2026-07-01T00:01:00.000Z'),
        },
      ]);
      sql = String(queryAll.mock.calls[0]?.[0] ?? '');
    } finally {
      queryAll.mockRestore();
    }

    expect(sql).toMatch(/SELECT id, node_id, agent_session_id, created_at\s+FROM attempts\s+WHERE node_id = \?\s+ORDER BY created_at ASC/);
    expect(sql).not.toMatch(/SELECT\s+\*/i);
    expect(sql).not.toMatch(/\berror\b/i);
  });

  it('uses the node_id, created_at index for cost attribution attempt reads', () => {
    const planRows = (adapter as any).db
      .prepare(`
        EXPLAIN QUERY PLAN
        SELECT id, node_id, agent_session_id, created_at
        FROM attempts
        WHERE node_id = ?
        ORDER BY created_at ASC
      `)
      .all('taskA') as Array<{ detail: string }>;
    const detail = planRows.map((row) => row.detail).join('\n');

    expect(detail).toContain('SEARCH attempts');
    expect(detail).toContain('idx_attempts_node_created');
    expect(detail).not.toContain('SCAN attempts');
    expect(detail).not.toContain('USE TEMP B-TREE');
  });

  it('loadAttempt returns undefined for missing ID', () => {
    expect(adapter.loadAttempt('nonexistent')).toBeUndefined();
  });

  it('updateAttempt updates specific fields', () => {
    const attempt = createAttempt('taskA', { status: 'running' });
    adapter.saveAttempt(attempt);

    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      exitCode: 0,
      completedAt: new Date('2024-01-01T01:00:00Z'),
      branch: 'invoker/taskA-a1',
      commit: 'def456',
    });

    const loaded = adapter.loadAttempt(attempt.id)!;
    expect(loaded.status).toBe('completed');
    expect(loaded.exitCode).toBe(0);
    expect(loaded.completedAt).toEqual(new Date('2024-01-01T01:00:00Z'));
    expect(loaded.branch).toBe('invoker/taskA-a1');
    expect(loaded.commit).toBe('def456');
  });

  it('claimAttemptForLaunch only claims pending or expired attempts', () => {
    const pending = createAttempt('taskA', { status: 'pending' });
    adapter.saveAttempt(pending);

    const now = new Date('2026-05-12T00:00:00Z');
    const leaseExpiresAt = new Date('2026-05-12T00:05:00Z');
    expect(adapter.claimAttemptForLaunch(pending.id, {
      status: 'claimed',
      claimedAt: now,
      lastHeartbeatAt: now,
      leaseExpiresAt,
    }, now)).toBe(true);
    expect(adapter.loadAttempt(pending.id)?.status).toBe('claimed');

    expect(adapter.claimAttemptForLaunch(pending.id, {
      status: 'claimed',
      claimedAt: new Date('2026-05-12T00:01:00Z'),
      lastHeartbeatAt: new Date('2026-05-12T00:01:00Z'),
      leaseExpiresAt: new Date('2026-05-12T00:06:00Z'),
    }, new Date('2026-05-12T00:01:00Z'))).toBe(false);

    expect(adapter.claimAttemptForLaunch(pending.id, {
      status: 'claimed',
      claimedAt: new Date('2026-05-12T00:06:00Z'),
      lastHeartbeatAt: new Date('2026-05-12T00:06:00Z'),
      leaseExpiresAt: new Date('2026-05-12T00:11:00Z'),
    }, new Date('2026-05-12T00:06:00Z'))).toBe(true);
  });

  it('does not hydrate a task with a superseded selected attempt as runnable', () => {
    const attempt = createAttempt('taskA', { status: 'superseded' });
    adapter.saveAttempt(attempt);
    adapter.updateTask('taskA', {
      status: 'running',
      execution: {
        selectedAttemptId: attempt.id,
        startedAt: new Date('2026-05-12T00:00:00Z'),
        lastHeartbeatAt: new Date('2026-05-12T00:01:00Z'),
      },
    });

    const [task] = adapter.loadTasks('wf-1');
    expect(task.status).toBe('stale');
    expect(task.execution.selectedAttemptId).toBe(attempt.id);
  });

  it('merge conflict JSON round-trip', () => {
    const attempt = createAttempt('taskA', {
      mergeConflict: {
        failedBranch: 'feat/broken',
        conflictFiles: ['src/main.ts', 'package.json'],
      },
    });
    adapter.saveAttempt(attempt);

    const loaded = adapter.loadAttempt(attempt.id)!;
    expect(loaded.mergeConflict).toEqual({
      failedBranch: 'feat/broken',
      conflictFiles: ['src/main.ts', 'package.json'],
    });
  });

  it('selected_attempt_id column exists on tasks table', () => {
    // The migration should have added the column
    const attempt = createAttempt('taskA', { status: 'completed' });
    adapter.saveAttempt(attempt);

    // Access the raw db to verify column exists.
    const db = (adapter as any).db;
    db.run('UPDATE tasks SET selected_attempt_id = ? WHERE id = ?', [attempt.id, 'taskA']);
    const stmt = db.prepare('SELECT selected_attempt_id FROM tasks WHERE id = ?');
    stmt.bind(['taskA']);
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();
    expect(row.selected_attempt_id).toBe(attempt.id);
  });
});
