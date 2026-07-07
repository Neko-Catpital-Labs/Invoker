/**
 * Migration routines for {@link SQLiteAdapter}, as free functions over a narrow
 * {@link SqliteExecutor} context (plus a {@link SqliteMigrationHost} for the raw
 * statement runner and adapter flags the executor deliberately omits).
 *
 * The adapter delegates to these from one-line methods so migration control flow
 * lives here while the DDL strings still come from `./sqlite-schema.js` and run
 * in the same order from the same call sites. Behavior is unchanged.
 */

import type { ExternalDependency } from '@invoker/workflow-core';
import {
  COLUMN_MIGRATIONS,
  POST_MIGRATION_STATEMENTS,
  WORKFLOWS_REBUILD_TABLE_DDL,
  WORKFLOWS_REBUILD_INSERT_DDL,
} from './sqlite-schema.js';
import type { SqliteExecutor } from './sqlite-executor.js';
import {
  normalizeExternalDependencies,
  mergeExternalDependencySets,
} from './sqlite-external-dependencies.js';

/** The low-level SQL runner the migrations need beyond {@link SqliteExecutor}. */
interface MigrationDatabase {
  run(sql: string, params?: unknown[]): void;
  getRowsModified(): number;
}

/** Adapter capabilities the migration routines need beyond the executor. */
export interface SqliteMigrationHost {
  readonly db: MigrationDatabase;
  readonly readOnly: boolean;
  markDirty(): void;
  reconcileTerminalSessionInvariants(): void;
}

/** Add columns that may not exist in older databases. */
export function migrate(exec: SqliteExecutor, host: SqliteMigrationHost): void {
  for (const sql of COLUMN_MIGRATIONS) {
    try {
      host.db.run(sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('duplicate column name')) {
        throw err;
      }
    }
  }
  migrateWorkflowStatusColumn(exec, host);
  dropTaskAutoFixAttemptsColumn(exec, host);

  if (!host.readOnly) {
    host.reconcileTerminalSessionInvariants();
  }

  // Replace old attempt_number index with created_at index, etc.
  for (const sql of POST_MIGRATION_STATEMENTS) {
    host.db.run(sql);
  }

  if (!host.readOnly) {
    migrateTestCommands(exec);
    migrateGatePolicyApprovedToCompleted(exec);
    migrateTaskExternalDependenciesToWorkflows(exec);
    runCompatibilityMigration(exec, host);
  }
}

export function migrateWorkflowStatusColumn(exec: SqliteExecutor, host: SqliteMigrationHost): void {
  if (host.readOnly) return;
  const columns = exec.queryAll('PRAGMA table_info(workflows)') as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'status')) return;

  const foreignKeys = exec.queryOne('PRAGMA foreign_keys') as { foreign_keys?: number } | undefined;
  const foreignKeysEnabled = foreignKeys?.foreign_keys === 1;
  if (foreignKeysEnabled) {
    host.db.run('PRAGMA foreign_keys = OFF');
  }
  host.db.run(WORKFLOWS_REBUILD_TABLE_DDL);
  host.db.run(WORKFLOWS_REBUILD_INSERT_DDL);
  host.db.run('DROP TABLE workflows');
  host.db.run('ALTER TABLE workflows_new RENAME TO workflows');
  if (foreignKeysEnabled) {
    host.db.run('PRAGMA foreign_keys = ON');
  }
  host.markDirty();
}

export function dropTaskAutoFixAttemptsColumn(exec: SqliteExecutor, host: SqliteMigrationHost): void {
  if (host.readOnly) return;
  const columns = exec.queryAll('PRAGMA table_info(tasks)') as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'auto_fix_attempts')) return;
  host.db.run('ALTER TABLE tasks DROP COLUMN auto_fix_attempts');
  host.markDirty();
}

/**
 * Rewrite `pnpm test packages/<pkg>/...` (incorrect root-level invocation)
 * to `cd packages/<pkg> && pnpm test -- <relative-path>`.
 * Idempotent: already-rewritten commands won't match the LIKE pattern.
 */
export function migrateTestCommands(exec: SqliteExecutor): void {
  try {
    const rows = exec.queryAll(
      `SELECT id, command FROM tasks WHERE command LIKE 'pnpm test packages/%' OR command LIKE 'pnpm test -- packages/%'`,
    ) as Array<{ id: string; command: string }>;

    for (const row of rows) {
      const fixed = rewritePnpmTestCommand(row.command);
      if (fixed !== row.command) {
        exec.execRun('UPDATE tasks SET command = ? WHERE id = ?', [fixed, row.id]);
      }
    }
  } catch {
    // Table may not exist yet on first run
  }
}

/**
 * Rewrite `gatePolicy: 'approved'` to `gatePolicy: 'completed'` in
 * external_dependencies JSON column.
 * Idempotent: subsequent runs find zero matches and do nothing.
 */
export function migrateGatePolicyApprovedToCompleted(exec: SqliteExecutor): void {
  try {
    const rows = exec.queryAll(
      `SELECT id, external_dependencies FROM tasks WHERE external_dependencies LIKE '%"gatePolicy":"approved"%'`,
    ) as Array<{ id: string; external_dependencies: string }>;

    for (const row of rows) {
      try {
        const deps = JSON.parse(row.external_dependencies) as Array<{
          workflowId: string;
          taskId?: string;
          requiredStatus: string;
          gatePolicy?: string;
        }>;

        let modified = false;
        for (const dep of deps) {
          if (dep.gatePolicy === 'approved') {
            dep.gatePolicy = 'completed';
            modified = true;
          }
        }

        if (modified) {
          const updated = JSON.stringify(deps);
          exec.execRun('UPDATE tasks SET external_dependencies = ? WHERE id = ?', [updated, row.id]);
        }
      } catch {
        // Skip malformed JSON rows
      }
    }
  } catch {
    // Table may not exist yet on first run
  }
}

/**
 * Promote legacy per-task external dependencies to workflow metadata.
 * This is intentionally idempotent: once task rows are cleared, later runs
 * only see the workflow-level source of truth.
 */
export function migrateTaskExternalDependenciesToWorkflows(exec: SqliteExecutor): void {
  try {
    const rows = exec.queryAll(
      `SELECT id, workflow_id, external_dependencies FROM tasks WHERE external_dependencies IS NOT NULL AND external_dependencies != ''`,
    ) as Array<{ id: string; workflow_id: string; external_dependencies: string }>;
    if (rows.length === 0) return;

    const incomingByWorkflow = new Map<string, ExternalDependency[]>();
    for (const row of rows) {
      try {
        const deps = normalizeExternalDependencies(JSON.parse(row.external_dependencies));
        if (deps.length === 0) continue;
        incomingByWorkflow.set(row.workflow_id, [
          ...(incomingByWorkflow.get(row.workflow_id) ?? []),
          ...deps,
        ]);
      } catch {
        // Skip malformed task JSON; do not clear it.
      }
    }

    for (const [workflowId, incoming] of incomingByWorkflow) {
      const wf = exec.queryOne(
        `SELECT external_dependencies FROM workflows WHERE id = ?`,
        [workflowId],
      ) as { external_dependencies?: string | null } | undefined;
      if (!wf) continue;
      let existing: ExternalDependency[] = [];
      if (wf.external_dependencies) {
        try {
          existing = normalizeExternalDependencies(JSON.parse(wf.external_dependencies));
        } catch {
          existing = [];
        }
      }
      const merged = mergeExternalDependencySets(existing, incoming);
      exec.execRun(
        `UPDATE workflows SET external_dependencies = ?, updated_at = ? WHERE id = ?`,
        [merged.length > 0 ? JSON.stringify(merged) : null, new Date().toISOString(), workflowId],
      );
    }

    exec.execRun(
      `UPDATE tasks SET external_dependencies = NULL WHERE external_dependencies IS NOT NULL AND external_dependencies != ''`,
    );
  } catch {
    // Tables/columns may not exist yet on first run.
  }
}

export function runCompatibilityMigration(
  exec: SqliteExecutor,
  host: SqliteMigrationHost,
): {
  migratedFixingWithAiStatuses: number;
  normalizedMergeModes: number;
  staleAutoFixExperimentTasks: number;
  normalizedStaleLaunchMetadata: number;
  normalizedLegacyAcknowledgedLaunchDispatches: number;
  backfilledMissingSshPoolMemberIds: number;
} {
  const report = {
    migratedFixingWithAiStatuses: 0,
    normalizedMergeModes: 0,
    staleAutoFixExperimentTasks: 0,
    normalizedStaleLaunchMetadata: 0,
    normalizedLegacyAcknowledgedLaunchDispatches: 0,
    backfilledMissingSshPoolMemberIds: 0,
  };
  exec.runTransaction(() => {
    host.db.run(
      `UPDATE tasks
         SET status = 'fixing_with_ai'
         WHERE status = 'running' AND is_fixing_with_ai = 1`,
    );
    report.migratedFixingWithAiStatuses = host.db.getRowsModified();

    host.db.run(
      `UPDATE tasks
         SET is_fixing_with_ai = 0
         WHERE status = 'fixing_with_ai' AND is_fixing_with_ai != 0`,
    );

    host.db.run(
      `UPDATE workflows
         SET merge_mode = 'external_review'
         WHERE merge_mode = 'github'`,
    );
    report.normalizedMergeModes = host.db.getRowsModified();

    const staleAutoFixRows = exec.queryAll(
      `SELECT id FROM tasks
         WHERE status != 'stale'
           AND (
             (parent_task IS NOT NULL AND id LIKE '%-exp-fix-%')
             OR (
               is_reconciliation = 1
               AND parent_task IN (
                 SELECT id FROM tasks
                 WHERE parent_task IS NOT NULL AND id LIKE '%-exp-fix-%'
               )
             )
           )`,
    );
    host.db.run(
      `UPDATE tasks
         SET status = 'stale',
             error = 'Stale auto-fix experiment branch; migrated to modern retry model',
             completed_at = COALESCE(completed_at, datetime('now')),
             is_fixing_with_ai = 0
         WHERE status != 'stale'
           AND (
             (parent_task IS NOT NULL AND id LIKE '%-exp-fix-%')
             OR (
               is_reconciliation = 1
               AND parent_task IN (
                 SELECT id FROM tasks
                 WHERE parent_task IS NOT NULL AND id LIKE '%-exp-fix-%'
               )
             )
           )`,
    );
    report.staleAutoFixExperimentTasks = staleAutoFixRows.length;

    host.db.run(
      `UPDATE tasks
         SET launch_phase = NULL,
             launch_started_at = NULL,
             launch_completed_at = NULL
         WHERE status IN ('completed', 'failed', 'needs_input', 'awaiting_approval', 'review_ready', 'stale')
           AND launch_started_at IS NOT NULL
           AND started_at IS NOT NULL
           AND (julianday(started_at) - julianday(launch_started_at)) * 86400.0 > 3600.0`,
    );
    report.normalizedStaleLaunchMetadata = host.db.getRowsModified();

    const nowIso = new Date().toISOString();
    const stalePendingLaunchRows = exec.queryAll(
      `SELECT t.id, t.selected_attempt_id
           FROM tasks t
           LEFT JOIN attempts a ON a.id = t.selected_attempt_id
          WHERE t.status = 'pending'
            AND t.launch_phase = 'launching'
            AND t.selected_attempt_id IS NOT NULL
            AND TRIM(t.selected_attempt_id) != ''
            AND NOT EXISTS (
              SELECT 1
                FROM task_launch_dispatch live
               WHERE live.task_id = t.id
                 AND live.attempt_id = t.selected_attempt_id
                 AND live.state IN ('enqueued', 'leased')
            )
            AND (
              a.id IS NULL
              OR a.lease_expires_at IS NULL
              OR a.lease_expires_at <= ?
            )`,
      [nowIso],
    ) as Array<{ id: string; selected_attempt_id?: string | null }>;
    if (stalePendingLaunchRows.length > 0) {
      const taskIds = stalePendingLaunchRows.map((row) => String(row.id));
      const taskPlaceholders = taskIds.map(() => '?').join(', ');
      host.db.run(
        `UPDATE tasks
              SET launch_phase = NULL,
                  launch_started_at = NULL,
                  launch_completed_at = NULL,
                  last_heartbeat_at = NULL
            WHERE id IN (${taskPlaceholders})`,
        taskIds,
      );

      const attemptIds = stalePendingLaunchRows
        .map((row) => row.selected_attempt_id)
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
      if (attemptIds.length > 0) {
        const attemptPlaceholders = attemptIds.map(() => '?').join(', ');
        host.db.run(
          `UPDATE attempts
                SET status = 'pending',
                    claimed_at = NULL,
                    last_heartbeat_at = NULL,
                    lease_expires_at = NULL
              WHERE id IN (${attemptPlaceholders})
                AND status = 'claimed'`,
          attemptIds,
        );
      }
      report.normalizedStaleLaunchMetadata += stalePendingLaunchRows.length;
    }

    host.db.run(
      `UPDATE task_launch_dispatch
         SET state = 'abandoned',
             completed_at = ?,
             last_error = 'Legacy acknowledged launch dispatch is stale after acknowledgement removal',
             dispatch_owner = NULL,
             fenced_until = NULL
         WHERE state = 'acknowledged'
           AND (
             NOT EXISTS (
               SELECT 1
               FROM tasks t
               WHERE t.id = task_launch_dispatch.task_id
                 AND t.status = 'pending'
                 AND COALESCE(t.selected_attempt_id, '') = task_launch_dispatch.attempt_id
                 AND COALESCE(t.execution_generation, 0) = task_launch_dispatch.generation
             )
             OR EXISTS (
               SELECT 1
               FROM task_launch_dispatch live
               WHERE live.attempt_id = task_launch_dispatch.attempt_id
                 AND live.id != task_launch_dispatch.id
                 AND live.state IN ('enqueued', 'leased')
             )
           )`,
      [nowIso],
    );
    report.normalizedLegacyAcknowledgedLaunchDispatches += host.db.getRowsModified();

    host.db.run(
      `UPDATE task_launch_dispatch
         SET state = 'leased',
             leased_at = COALESCE(leased_at, acknowledged_at, ?),
             acknowledged_at = NULL
         WHERE state = 'acknowledged'
           AND fenced_until IS NOT NULL
           AND fenced_until >= ?`,
      [nowIso, nowIso],
    );
    report.normalizedLegacyAcknowledgedLaunchDispatches += host.db.getRowsModified();

    host.db.run(
      `UPDATE task_launch_dispatch
         SET state = 'enqueued',
             dispatch_owner = NULL,
             leased_at = NULL,
             acknowledged_at = NULL,
             fenced_until = NULL
         WHERE state = 'acknowledged'`,
    );
    report.normalizedLegacyAcknowledgedLaunchDispatches += host.db.getRowsModified();

    // One-time compatibility backfill for SSH tasks created before
    // pool_member_id was durably written to tasks. Runtime routing must use
    // tasks.pool_member_id; this audit-event fallback is migration-only and
    // can be deleted after old databases no longer need the backfill.
    const missingSshPoolRows = exec.queryAll(
      `SELECT t.id, e.payload
         FROM tasks t
         JOIN events e ON e.id = (
           SELECT MAX(id)
           FROM events
           WHERE task_id = t.id
             AND event_type = 'task.executor.selected'
         )
         WHERE t.runner_kind = 'ssh'
           AND (t.pool_member_id IS NULL OR TRIM(t.pool_member_id) = '')
           AND t.workspace_path IS NOT NULL
           AND TRIM(t.workspace_path) != ''
           AND e.payload IS NOT NULL`,
    ) as Array<{ id: string; payload?: string | null }>;
    for (const row of missingSshPoolRows) {
      const poolMemberId = parseExecutorSelectedPoolMemberId(row.payload);
      if (!poolMemberId) continue;
      host.db.run(
        `UPDATE tasks
           SET pool_member_id = ?,
               task_state_version = task_state_version + 1
           WHERE id = ?
             AND runner_kind = 'ssh'
             AND (pool_member_id IS NULL OR TRIM(pool_member_id) = '')
             AND workspace_path IS NOT NULL
             AND TRIM(workspace_path) != ''`,
        [poolMemberId, row.id],
      );
      report.backfilledMissingSshPoolMemberIds += host.db.getRowsModified();
    }
  });
  return report;
}

function rewritePnpmTestCommand(cmd: string): string {
  const withFile = cmd.match(/^(pnpm test)\s+(?:--\s+)?packages\/([^/\s]+)\/(\S+)(.*)/);
  if (withFile) {
    const [, , pkg, rest, suffix] = withFile;
    return `cd packages/${pkg} && pnpm test -- ${rest}${suffix}`;
  }
  const pkgOnly = cmd.match(/^(pnpm test)\s+(?:--\s+)?packages\/([^/\s]+)(.*)/);
  if (pkgOnly) {
    const [, , pkg, suffix] = pkgOnly;
    return `cd packages/${pkg} && pnpm test${suffix}`;
  }
  return cmd;
}

function parseExecutorSelectedPoolMemberId(payload: string | null | undefined): string | undefined {
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(payload) as { poolMemberId?: unknown };
    return typeof parsed.poolMemberId === 'string' && parsed.poolMemberId.trim()
      ? parsed.poolMemberId.trim()
      : undefined;
  } catch {
    return undefined;
  }
}
