import type { ExternalDependency } from '@invoker/workflow-core';
import {
  COLUMN_MIGRATIONS,
  POST_MIGRATION_STATEMENTS,
  WORKFLOWS_REBUILD_TABLE_DDL,
  WORKFLOWS_REBUILD_INSERT_DDL,
} from './sqlite-schema.js';
import {
  normalizeExternalDependencies,
  mergeExternalDependencySets,
} from './sqlite-external-dependencies.js';
import type { SqliteExecutor } from './sqlite-executor.js';

/**
 * Log a caught migration error instead of dropping it silently. Migrations
 * tolerate missing tables/columns and malformed rows so a partial upgrade never
 * aborts startup, but the error is still surfaced with context to debug later.
 */
function logSwallowedMigrationError(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[sqlite-migrations] ${context}: ${message}`);
}

/**
 * Rewrite `pnpm test packages/<pkg>/...` (incorrect root-level invocation)
 * to `cd packages/<pkg> && pnpm test -- <relative-path>`.
 */
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
  } catch (err) {
    logSwallowedMigrationError(
      'parseExecutorSelectedPoolMemberId: malformed task.executor.selected payload',
      err,
    );
    return undefined;
  }
}

export function migrate(exec: SqliteExecutor, reconcileTerminalSessionInvariants: () => void): void {
  for (const sql of COLUMN_MIGRATIONS) {
    try {
      exec.run(sql);
    } catch (err) {
      // A "duplicate column name" error means the column already exists
      // (idempotent re-run); rethrow anything else.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('duplicate column name')) {
        throw err;
      }
    }
  }
  migrateWorkflowStatusColumn(exec);
  dropTaskAutoFixAttemptsColumn(exec);

  if (!exec.readOnly) {
    reconcileTerminalSessionInvariants();
  }

  for (const sql of POST_MIGRATION_STATEMENTS) {
    exec.run(sql);
  }

  if (!exec.readOnly) {
    backfillEventTypeCounters(exec);
    migrateTestCommands(exec);
    migrateGatePolicyApprovedToCompleted(exec);
    migrateTaskExternalDependenciesToWorkflows(exec);
    runCompatibilityMigration(exec);
  }
}

/**
 * Seed event_type_counters from existing rows exactly once, for databases that
 * predate the counter table (created empty by SCHEMA_DDL on this open). The
 * AFTER INSERT/DELETE triggers keep it exact from here on; this one-time
 * COUNT(*) GROUP BY scan (~140ms at 2M rows, at startup only) closes the gap for
 * the rows that existed before the triggers did. Idempotent: once the table has
 * any row it never re-scans, so a later full wipe (which clears the table) is not
 * re-seeded from an empty events table.
 */
export function backfillEventTypeCounters(exec: SqliteExecutor): void {
  try {
    const seeded = Number(
      (exec.queryOne('SELECT COUNT(*) AS c FROM event_type_counters') as { c?: number } | undefined)?.c ?? 0,
    );
    if (seeded > 0) return;
    exec.run(`
      INSERT INTO event_type_counters (event_type, count)
      SELECT event_type, COUNT(*) FROM events GROUP BY event_type
      ON CONFLICT(event_type) DO UPDATE SET count = excluded.count
    `);
  } catch (err) {
    logSwallowedMigrationError('backfillEventTypeCounters', err);
  }
}

export function runCompatibilityMigration(exec: SqliteExecutor): {
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
    exec.run(
      `UPDATE tasks
         SET status = 'fixing_with_ai'
         WHERE status = 'running' AND is_fixing_with_ai = 1`,
    );
    report.migratedFixingWithAiStatuses = exec.getRowsModified();

    exec.run(
      `UPDATE tasks
         SET is_fixing_with_ai = 0
         WHERE status = 'fixing_with_ai' AND is_fixing_with_ai != 0`,
    );

    exec.run(
      `UPDATE workflows
         SET merge_mode = 'external_review'
         WHERE merge_mode = 'github'`,
    );
    report.normalizedMergeModes = exec.getRowsModified();

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
    exec.run(
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

    exec.run(
      `UPDATE tasks
         SET launch_phase = NULL,
             launch_started_at = NULL,
             launch_completed_at = NULL
         WHERE status IN ('completed', 'failed', 'needs_input', 'awaiting_approval', 'review_ready', 'stale')
           AND launch_started_at IS NOT NULL
           AND started_at IS NOT NULL
           AND (julianday(started_at) - julianday(launch_started_at)) * 86400.0 > 3600.0`,
    );
    report.normalizedStaleLaunchMetadata = exec.getRowsModified();

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
      exec.run(
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
        exec.run(
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

    exec.run(
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
    report.normalizedLegacyAcknowledgedLaunchDispatches += exec.getRowsModified();

    exec.run(
      `UPDATE task_launch_dispatch
         SET state = 'leased',
             leased_at = COALESCE(leased_at, acknowledged_at, ?),
             acknowledged_at = NULL
         WHERE state = 'acknowledged'
           AND fenced_until IS NOT NULL
           AND fenced_until >= ?`,
      [nowIso, nowIso],
    );
    report.normalizedLegacyAcknowledgedLaunchDispatches += exec.getRowsModified();

    exec.run(
      `UPDATE task_launch_dispatch
         SET state = 'enqueued',
             dispatch_owner = NULL,
             leased_at = NULL,
             acknowledged_at = NULL,
             fenced_until = NULL
         WHERE state = 'acknowledged'`,
    );
    report.normalizedLegacyAcknowledgedLaunchDispatches += exec.getRowsModified();

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
      exec.run(
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
      report.backfilledMissingSshPoolMemberIds += exec.getRowsModified();
    }
  });
  return report;
}

export function migrateWorkflowStatusColumn(exec: SqliteExecutor): void {
  if (exec.readOnly) return;
  const columns = exec.queryAll('PRAGMA table_info(workflows)') as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'status')) return;

  const foreignKeys = exec.queryOne('PRAGMA foreign_keys') as { foreign_keys?: number } | undefined;
  const foreignKeysEnabled = foreignKeys?.foreign_keys === 1;
  if (foreignKeysEnabled) {
    exec.run('PRAGMA foreign_keys = OFF');
  }
  exec.run(WORKFLOWS_REBUILD_TABLE_DDL);
  exec.run(WORKFLOWS_REBUILD_INSERT_DDL);
  exec.run('DROP TABLE workflows');
  exec.run('ALTER TABLE workflows_new RENAME TO workflows');
  if (foreignKeysEnabled) {
    exec.run('PRAGMA foreign_keys = ON');
  }
  exec.markDirty();
}

export function dropTaskAutoFixAttemptsColumn(exec: SqliteExecutor): void {
  if (exec.readOnly) return;
  const columns = exec.queryAll('PRAGMA table_info(tasks)') as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'auto_fix_attempts')) return;
  exec.run('ALTER TABLE tasks DROP COLUMN auto_fix_attempts');
  exec.markDirty();
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
  } catch (err) {
    // Tolerate a missing tasks table (initSchema creates it first); surface anything else.
    logSwallowedMigrationError('migrateTestCommands', err);
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
      } catch (err) {
        logSwallowedMigrationError(
          `migrateGatePolicyApprovedToCompleted: skipping malformed external_dependencies for task ${row.id}`,
          err,
        );
      }
    }
  } catch (err) {
    logSwallowedMigrationError('migrateGatePolicyApprovedToCompleted', err);
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

    const incomingByWorkflow = new Map<string, { deps: ExternalDependency[]; taskIds: string[] }>();
    for (const row of rows) {
      try {
        const deps = normalizeExternalDependencies(JSON.parse(row.external_dependencies));
        if (deps.length === 0) continue;
        const entry = incomingByWorkflow.get(row.workflow_id) ?? { deps: [], taskIds: [] };
        entry.deps.push(...deps);
        entry.taskIds.push(row.id);
        incomingByWorkflow.set(row.workflow_id, entry);
      } catch (err) {
        logSwallowedMigrationError(
          `migrateTaskExternalDependenciesToWorkflows: skipping malformed external_dependencies for task ${row.id}`,
          err,
        );
      }
    }

    const promotedTaskIds: string[] = [];
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
        } catch (err) {
          logSwallowedMigrationError(
            `migrateTaskExternalDependenciesToWorkflows: resetting unparseable workflow external_dependencies for workflow ${workflowId}`,
            err,
          );
          existing = [];
        }
      }
      const merged = mergeExternalDependencySets(existing, incoming.deps);
      exec.execRun(
        `UPDATE workflows SET external_dependencies = ?, updated_at = ? WHERE id = ?`,
        [merged.length > 0 ? JSON.stringify(merged) : null, new Date().toISOString(), workflowId],
      );
      promotedTaskIds.push(...incoming.taskIds);
    }

    // Clear only tasks whose deps were promoted to an existing workflow; leave
    // malformed rows and orphaned tasks (missing workflow) untouched so their
    // dependency data is not silently lost.
    if (promotedTaskIds.length > 0) {
      const placeholders = promotedTaskIds.map(() => '?').join(', ');
      exec.execRun(
        `UPDATE tasks SET external_dependencies = NULL WHERE id IN (${placeholders})`,
        promotedTaskIds,
      );
    }
  } catch (err) {
    logSwallowedMigrationError('migrateTaskExternalDependenciesToWorkflows', err);
  }
}
