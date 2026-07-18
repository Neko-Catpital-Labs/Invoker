import { describe, it, expect, vi, afterEach } from 'vitest';
import * as migrations from '../sqlite-migrations.js';
import type { SqliteExecutor } from '../sqlite-executor.js';

/**
 * Guards the CLAUDE.md invariant for this module: migrations tolerate missing
 * tables and malformed rows so a partial upgrade never aborts startup, but a
 * caught error is logged with context — never silently swallowed.
 */
function stubExecutor(overrides: Partial<SqliteExecutor> = {}): SqliteExecutor {
  const notExist = (): never => {
    throw new Error('no such table: tasks');
  };
  return {
    queryOne: notExist,
    queryAll: notExist,
    execRun: () => {},
    runTransaction: <T>(work: () => T): T => work(),
    run: () => {},
    getRowsModified: () => 0,
    readOnly: false,
    markDirty: () => {},
    ...overrides,
  };
}

describe('sqlite-migrations error logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('surfaces the caught error instead of swallowing when a query fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cases: Array<[string, (exec: SqliteExecutor) => void]> = [
      ['migrateTestCommands', migrations.migrateTestCommands],
      ['migrateGatePolicyApprovedToCompleted', migrations.migrateGatePolicyApprovedToCompleted],
      ['migrateTaskExternalDependenciesToWorkflows', migrations.migrateTaskExternalDependenciesToWorkflows],
    ];
    for (const [name, fn] of cases) {
      warn.mockClear();
      expect(() => fn(stubExecutor())).not.toThrow();
      const messages = warn.mock.calls.map(([m]) => String(m));
      expect(messages.some((m) => m.includes(`[sqlite-migrations] ${name}`))).toBe(true);
      expect(messages.some((m) => m.includes('no such table'))).toBe(true);
    }
  });

  it('logs and skips a malformed row while still migrating valid siblings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const exec = stubExecutor({
      queryAll: () => [
        {
          id: 'good',
          external_dependencies: JSON.stringify([
            { workflowId: 'wf', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'approved' },
          ]),
        },
        { id: 'bad', external_dependencies: '{ not valid json' },
      ],
      execRun: (_sql, params) => {
        updates.push(params ?? []);
      },
    });

    expect(() => migrations.migrateGatePolicyApprovedToCompleted(exec)).not.toThrow();

    // Valid row was rewritten to the completed gate policy.
    expect(updates).toHaveLength(1);
    expect(String(updates[0]![0])).toContain('"gatePolicy":"completed"');

    // Malformed row was logged with its id, not silently dropped.
    const messages = warn.mock.calls.map(([m]) => String(m));
    expect(messages.some((m) => m.includes('[sqlite-migrations]') && m.includes('bad'))).toBe(true);
  });

  it('clears only tasks whose deps were promoted, leaving malformed and orphaned rows untouched', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const clearedIds: unknown[][] = [];
    const validDep = JSON.stringify([
      { workflowId: 'wf-1', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'completed' },
    ]);
    const orphanDep = JSON.stringify([
      { workflowId: 'wf-missing', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'completed' },
    ]);
    const exec = stubExecutor({
      queryAll: () => [
        { id: 'promoted', workflow_id: 'wf-1', external_dependencies: validDep },
        { id: 'malformed', workflow_id: 'wf-1', external_dependencies: '{ not json' },
        { id: 'orphan', workflow_id: 'wf-missing', external_dependencies: orphanDep },
      ],
      queryOne: (_sql, params) => (params?.[0] === 'wf-1' ? { external_dependencies: null } : undefined),
      execRun: (sql, params) => {
        if (sql.includes('UPDATE tasks SET external_dependencies = NULL')) {
          clearedIds.push(params ?? []);
        }
      },
    });

    expect(() => migrations.migrateTaskExternalDependenciesToWorkflows(exec)).not.toThrow();

    // Only the promoted task is cleared; the malformed row and the orphan whose
    // workflow is missing keep their external_dependencies intact.
    expect(clearedIds).toHaveLength(1);
    expect(clearedIds[0]).toEqual(['promoted']);

    const messages = warn.mock.calls.map(([m]) => String(m));
    expect(messages.some((m) => m.includes('[sqlite-migrations]') && m.includes('malformed'))).toBe(true);
  });
});
