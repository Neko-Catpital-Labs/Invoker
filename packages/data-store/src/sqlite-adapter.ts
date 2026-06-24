/**
 * SQLiteAdapter — PersistenceAdapter backed by native SQLite.
 *
 * Uses `:memory:` for testing, file path for production.
 * Construction remains async for API compatibility, all operations after init are synchronous.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type {
  TaskState,
  TaskStateChanges,
  Attempt,
  TaskStatus,
  WorkflowRollup,
  WorkflowRollupTaskSummary,
  ExternalDependency,
  ExternalDependencyChange,
  DetachedExternalDependency,
} from '@invoker/workflow-core';
import { DISPATCH_LEASE_MS } from '@invoker/contracts';
import type { SearchResultItem, SearchOptions } from '@invoker/contracts';
import {
  computeWorkflowRollupFromSummaries,
  isDiscardedAttempt,
  normalizeRunnerKind,
} from '@invoker/workflow-core';
import type {
  ExecutionResourceLeaseReleaseRow,
  LaunchDispatchInvalidationRow,
  PersistenceAdapter,
  Workflow,
  WorkflowSaveInput,
  WorkflowTaskSnapshot,
  TaskEvent,
  ActivityLogEntry,
  Conversation,
  ConversationMessage,
  WorkflowChannel,
} from './adapter.js';
import {
  SCHEMA_DDL,
  COLUMN_MIGRATIONS,
  POST_MIGRATION_STATEMENTS,
  WORKFLOWS_REBUILD_TABLE_DDL,
  WORKFLOWS_REBUILD_INSERT_DDL,
} from './sqlite-schema.js';
import {
  mapRowToWorkflow,
  mapRowToTask,
  mapRowToAttempt,
  mapRowToTaskLaunchDispatch,
  mapRowToWorkflowMutationIntent,
  mapRowToWorkflowMutationLease,
} from './sqlite-row-mappers.js';

type NativeSqlite = typeof import('node:sqlite');

let nativeSqlite: Promise<NativeSqlite> | undefined;
const nativeSqliteSpecifier = 'node:' + 'sqlite';

function loadNativeSqlite(): Promise<NativeSqlite> {
  nativeSqlite ??= import(nativeSqliteSpecifier) as Promise<NativeSqlite>;
  return nativeSqlite;
}
const ACTION_GRAPH_RECENT_ATTEMPT_LIMIT = 3;

// activity_log is capped to its most recent rows so the DB file stays bounded; 0 disables.
const DEFAULT_ACTIVITY_LOG_MAX_ROWS = 100_000;
const ACTIVITY_LOG_PRUNE_INTERVAL = 1_000; // prune at most once per N writes

const OUTPUT_DIAGNOSTIC_TAIL_CHARS = 8_000;


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

export interface OutputChunk {
  offset: number;
  data: string;
}

interface SQLiteAdapterOptions {
  readOnly?: boolean;
  ownerCapability?: boolean;
  outputTailLimit?: number;
  outputDir?: string;
  /** Max retained activity_log rows; 0 disables retention. */
  activityLogMaxRows?: number;
}

export type WorkflowMutationPriority = 'high' | 'normal';
export type WorkflowMutationIntentStatus = 'queued' | 'running' | 'completed' | 'failed';
export const WORKFLOW_MUTATION_LEASE_MS = 30_000;
export const EXECUTION_RESOURCE_LEASE_MS = 20 * 60 * 1000;

export interface ExecutionResourceLease {
  resourceKey: string;
  resourceType: string;
  holderId: string;
  taskId?: string;
  poolId?: string;
  poolMemberId?: string;
  acquiredAt: string;
  lastHeartbeatAt: string;
  leaseExpiresAt: string;
  metadata?: unknown;
}

type SQLiteParams = unknown[] | Record<string, unknown>;

function normalizeParams(params: SQLiteParams = []): unknown[] | Record<string, unknown> {
  return Array.isArray(params) ? params : params;
}

function paramsToArgs(params: SQLiteParams = []): unknown[] {
  return Array.isArray(params) ? params : [params];
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

class NativeStatementCompat {
  private boundParams: SQLiteParams = [];
  private iterator: Iterator<Record<string, unknown>> | null = null;
  private current: Record<string, unknown> | undefined;

  constructor(private readonly stmt: StatementSync) {}

  bind(params: SQLiteParams = []): void {
    this.boundParams = normalizeParams(params);
    this.iterator = null;
    this.current = undefined;
  }

  step(): boolean {
    if (!this.iterator) {
      this.iterator = this.stmt.iterate(...(paramsToArgs(this.boundParams) as any[])) as Iterator<Record<string, unknown>>;
    }
    const next = this.iterator.next();
    this.current = next.done ? undefined : next.value;
    return !next.done;
  }

  getAsObject(): Record<string, unknown> {
    return this.current ?? {};
  }

  get(...params: unknown[]): Record<string, unknown> | undefined {
    return this.stmt.get(...(params as any[])) as Record<string, unknown> | undefined;
  }

  all(...params: unknown[]): Record<string, unknown>[] {
    return this.stmt.all(...(params as any[])) as Record<string, unknown>[];
  }

  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.stmt.run(...(params as any[]));
  }

  free(): void {
    this.iterator = null;
    this.current = undefined;
  }
}

class NativeDatabaseCompat {
  private lastChanges = 0;

  constructor(private readonly db: DatabaseSync) {}

  run(sql: string, params: SQLiteParams = []): void {
    const trimmed = sql.trim();
    if (Array.isArray(params) && params.length === 0 && !trimmed.includes('?') && trimmed.split(';').filter(Boolean).length > 1) {
      this.db.exec(sql);
      this.lastChanges = 0;
      return;
    }
    const result = this.db.prepare(sql).run(...(paramsToArgs(params) as any[]));
    this.lastChanges = Number(result.changes);
  }

  prepare(sql: string): NativeStatementCompat {
    return new NativeStatementCompat(this.db.prepare(sql));
  }

  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }> {
    const trimmed = sql.trim();
    if (/^(?:SELECT|PRAGMA)\b/i.test(trimmed)) {
      const stmt = this.db.prepare(sql);
      const rows = stmt.all() as Record<string, unknown>[];
      const columns = stmt.columns().map((column) => column.name);
      return [{ columns, values: rows.map((row) => columns.map((column) => row[column])) }];
    }
    this.db.exec(sql);
    this.lastChanges = 0;
    return [];
  }

  getRowsModified(): number {
    return this.lastChanges;
  }

  close(): void {
    this.db.close();
  }
}

export interface WorkflowMutationIntent {
  id: number;
  workflowId: string;
  channel: string;
  args: unknown[];
  priority: WorkflowMutationPriority;
  status: WorkflowMutationIntentStatus;
  ownerId?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface WorkflowMutationLease {
  workflowId: string;
  ownerId: string;
  activeIntentId?: number;
  activeMutationKind?: string;
  leasedAt: string;
  lastHeartbeatAt: string;
  leaseExpiresAt: string;
}

export type TaskLaunchDispatchState =
  | 'enqueued'
  | 'leased'
  | 'completed'
  | 'abandoned';

export type TaskLaunchDispatchPriority = 'high' | 'normal' | 'low';

export interface TaskLaunchDispatch {
  id: number;
  taskId: string;
  attemptId: string;
  workflowId: string;
  state: TaskLaunchDispatchState;
  priority: TaskLaunchDispatchPriority;
  dispatchOwner?: string;
  enqueuedAt: string;
  leasedAt?: string;
  completedAt?: string;
  fencedUntil?: string;
  attemptsCount: number;
  lastError?: string;
  generation: number;
}

export class SQLiteAdapter implements PersistenceAdapter {
  private db: NativeDatabaseCompat;
  private nativeDb: DatabaseSync;
  private dbPath: string | null;
  private readOnly: boolean;
  private dirty = false;
  private outputTailLimit: number;
  private outputTailCache = new Map<string, OutputChunk[]>();
  private outputDir: string;
  private spoolNextOffsetCache = new Map<string, number>();
  private writeTransactionDepth = 0;
  private lastWorkflowTaskSnapshotStats: Record<string, unknown> | null = null;
  private readonly activityLogMaxRows: number;
  private activityLogWritesSincePrune = 0;

  /** Use SQLiteAdapter.create() instead. */
  private constructor(db: DatabaseSync, dbPath: string | null, options?: SQLiteAdapterOptions) {
    this.nativeDb = db;
    this.db = new NativeDatabaseCompat(db);
    this.dbPath = dbPath;
    this.readOnly = options?.readOnly === true;
    this.outputTailLimit = options?.outputTailLimit ?? 100;
    this.outputDir = options?.outputDir ?? this.resolveOutputDir(dbPath);
    this.activityLogMaxRows = options?.activityLogMaxRows ?? DEFAULT_ACTIVITY_LOG_MAX_ROWS;
    this.configureConnection(dbPath !== null);
    if (!this.readOnly) {
      this.initSchema();
      this.migrate();
    }
  }

  /**
   * Async factory — opens or creates the database.
   * If the on-disk file is corrupted, backs it up and starts fresh.
   * @param dbPath File path or ':memory:' (default).
   * @param options readOnly=true opens DB for read operations without schema mutation.
   *                ownerCapability=true is required to open DB in writable mode for file-backed databases.
   */
  static async create(dbPath: string = ':memory:', options?: SQLiteAdapterOptions): Promise<SQLiteAdapter> {
    const isFile = dbPath !== ':memory:';
    const requestWritable = options?.readOnly !== true;

    // Enforce owner-only writable initialization for file-backed databases
    if (isFile && requestWritable && !options?.ownerCapability) {
      throw new Error(
        'Writable persistence initialization requires owner capability. ' +
        'Non-owner processes must delegate mutations via IPC (headless.run, headless.resume, headless.exec) ' +
        'or open the database in read-only mode.',
      );
    }

    if (isFile) {
      mkdirSync(dirname(dbPath), { recursive: true });
    }

    try {
      const { DatabaseSync } = await loadNativeSqlite();
      const db = new DatabaseSync(dbPath, { readOnly: options?.readOnly === true });
      return new SQLiteAdapter(db, isFile ? dbPath : null, options);
    } catch (err) {
      if (!isFile || options?.readOnly === true || !existsSync(dbPath)) {
        throw err;
      }
      const backupPath = `${dbPath}.corrupt-${Date.now()}`;
      console.error(
        `[SQLiteAdapter] Database corrupted (${err instanceof Error ? err.message : String(err)}). ` +
        `Backing up to ${backupPath} and starting fresh.`,
      );
      renameSync(dbPath, backupPath);
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${dbPath}${suffix}`;
        if (existsSync(sidecar)) renameSync(sidecar, `${backupPath}${suffix}`);
      }
      const { DatabaseSync } = await loadNativeSqlite();
      const db = new DatabaseSync(dbPath);
      return new SQLiteAdapter(db, dbPath, options);
    }
  }

  private resolveOutputDir(dbPath: string | null): string {
    const invokerHome = process.env.INVOKER_DB_DIR ?? (dbPath ? dirname(dbPath) : join(homedir(), '.invoker'));
    if (!dbPath && !process.env.INVOKER_DB_DIR) {
      return join(tmpdir(), `invoker-output-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    }
    return join(invokerHome, 'task-output');
  }

  private configureConnection(fileBacked: boolean): void {
    this.nativeDb.exec('PRAGMA busy_timeout = 5000');
    this.nativeDb.exec('PRAGMA foreign_keys = ON');
    if (fileBacked) {
      this.nativeDb.exec('PRAGMA journal_mode = WAL');
      this.nativeDb.exec('PRAGMA synchronous = FULL');
      this.nativeDb.exec('PRAGMA wal_autocheckpoint = 1000');
    }
  }

  // ── SQLite Helpers ───────────────────────────────────────

  /** Run a single-row SELECT, returning the row as an object or undefined. */
  private queryOne(sql: string, params: unknown[] = []): Record<string, unknown> | undefined {
    const stmt = this.db.prepare(sql);
    try {
      return stmt.get(...(paramsToArgs(params) as any[])) as Record<string, unknown> | undefined;
    } finally {
      stmt.free();
    }
  }

  /** Run a multi-row SELECT, returning an array of row objects. */
  private queryAll(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    const stmt = this.db.prepare(sql);
    try {
      return stmt.all(...(paramsToArgs(params) as any[])) as Record<string, unknown>[];
    } finally {
      stmt.free();
    }
  }

  private ensureWritable(): void {
    if (this.readOnly) {
      throw new Error('SQLiteAdapter is read-only in this process');
    }
  }

  /** Run an INSERT/UPDATE/DELETE. File-backed durability is handled by SQLite/WAL. */
  private execRun(sql: string, params: unknown[] = []): void {
    this.ensureWritable();
    this.db.run(sql, params as any[]);
    this.dirty = true;
  }

  private runTransaction<T>(work: () => T): T {
    this.ensureWritable();
    this.db.run(this.writeTransactionDepth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT invoker_nested_${this.writeTransactionDepth}`);
    this.writeTransactionDepth += 1;
    try {
      const result = work();
      this.writeTransactionDepth -= 1;
      this.db.run(this.writeTransactionDepth === 0 ? 'COMMIT' : `RELEASE invoker_nested_${this.writeTransactionDepth}`);
      this.dirty = true;
      return result;
    } catch (err) {
      this.writeTransactionDepth = Math.max(0, this.writeTransactionDepth - 1);
      try {
        this.db.run(this.writeTransactionDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO invoker_nested_${this.writeTransactionDepth}`);
      } catch {
        // Preserve the original statement failure if SQLite already aborted the
        // transaction before we reached this cleanup path.
      }
      throw err;
    }
  }

  /** Public transactional wrapper for higher-level batched write paths. */
  runInTransaction<T>(work: () => T): T {
    return this.runTransaction(work);
  }

  runCompatibilityMigration(): {
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
    this.runTransaction(() => {
      this.db.run(
        `UPDATE tasks
         SET status = 'fixing_with_ai'
         WHERE status = 'running' AND is_fixing_with_ai = 1`,
      );
      report.migratedFixingWithAiStatuses = this.db.getRowsModified();

      this.db.run(
        `UPDATE tasks
         SET is_fixing_with_ai = 0
         WHERE status = 'fixing_with_ai' AND is_fixing_with_ai != 0`,
      );

      this.db.run(
        `UPDATE workflows
         SET merge_mode = 'external_review'
         WHERE merge_mode = 'github'`,
      );
      report.normalizedMergeModes = this.db.getRowsModified();

      const staleAutoFixRows = this.queryAll(
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
      this.db.run(
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

      this.db.run(
        `UPDATE tasks
         SET launch_phase = NULL,
             launch_started_at = NULL,
             launch_completed_at = NULL
         WHERE status IN ('completed', 'failed', 'needs_input', 'awaiting_approval', 'review_ready', 'stale')
           AND launch_started_at IS NOT NULL
           AND started_at IS NOT NULL
           AND (julianday(started_at) - julianday(launch_started_at)) * 86400.0 > 3600.0`,
      );
      report.normalizedStaleLaunchMetadata = this.db.getRowsModified();

      const nowIso = new Date().toISOString();
      const stalePendingLaunchRows = this.queryAll(
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
        this.db.run(
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
          this.db.run(
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

      this.db.run(
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
      report.normalizedLegacyAcknowledgedLaunchDispatches += this.db.getRowsModified();

      this.db.run(
        `UPDATE task_launch_dispatch
         SET state = 'leased',
             leased_at = COALESCE(leased_at, acknowledged_at, ?),
             acknowledged_at = NULL
         WHERE state = 'acknowledged'
           AND fenced_until IS NOT NULL
           AND fenced_until >= ?`,
        [nowIso, nowIso],
      );
      report.normalizedLegacyAcknowledgedLaunchDispatches += this.db.getRowsModified();

      this.db.run(
        `UPDATE task_launch_dispatch
         SET state = 'enqueued',
             dispatch_owner = NULL,
             leased_at = NULL,
             acknowledged_at = NULL,
             fenced_until = NULL
         WHERE state = 'acknowledged'`,
      );
      report.normalizedLegacyAcknowledgedLaunchDispatches += this.db.getRowsModified();

      // One-time compatibility backfill for SSH tasks created before
      // pool_member_id was durably written to tasks. Runtime routing must use
      // tasks.pool_member_id; this audit-event fallback is migration-only and
      // can be deleted after old databases no longer need the backfill.
      const missingSshPoolRows = this.queryAll(
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
        const poolMemberId = this.parseExecutorSelectedPoolMemberId(row.payload);
        if (!poolMemberId) continue;
        this.db.run(
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
        report.backfilledMissingSshPoolMemberIds += this.db.getRowsModified();
      }
    });
    return report;
  }

  private parseExecutorSelectedPoolMemberId(payload: string | null | undefined): string | undefined {
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

  checkpointWal(mode: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE' = 'PASSIVE'): void {
    if (!this.dbPath) return;
    try {
      this.nativeDb.exec(`PRAGMA wal_checkpoint(${mode})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/locked|busy/i.test(message)) {
        throw err;
      }
    }
  }

  async backupTo(destinationPath: string): Promise<void> {
    if (!this.dbPath) {
      throw new Error('SQLiteAdapter.backupTo requires a file-backed database');
    }
    mkdirSync(dirname(destinationPath), { recursive: true });
    const { backup } = await loadNativeSqlite();
    await backup(this.nativeDb, destinationPath);
    this.checkpointWal('PASSIVE');
  }

  private initSchema(): void {
    this.db.run(SCHEMA_DDL);
  }

  /** Add columns that may not exist in older databases. */
  private migrate(): void {
    for (const sql of COLUMN_MIGRATIONS) {
      try {
        this.db.run(sql);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('duplicate column name')) {
          throw err;
        }
      }
    }
    this.migrateWorkflowStatusColumn();

    // Replace old attempt_number index with created_at index, etc.
    for (const sql of POST_MIGRATION_STATEMENTS) {
      this.db.run(sql);
    }

    if (!this.readOnly) {
      this.migrateTestCommands();
      this.migrateGatePolicyApprovedToCompleted();
      this.migrateTaskExternalDependenciesToWorkflows();
      this.runCompatibilityMigration();
    }
  }

  private migrateWorkflowStatusColumn(): void {
    if (this.readOnly) return;
    const columns = this.queryAll('PRAGMA table_info(workflows)') as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'status')) return;

    const foreignKeys = this.queryOne('PRAGMA foreign_keys') as { foreign_keys?: number } | undefined;
    const foreignKeysEnabled = foreignKeys?.foreign_keys === 1;
    if (foreignKeysEnabled) {
      this.db.run('PRAGMA foreign_keys = OFF');
    }
    this.db.run(WORKFLOWS_REBUILD_TABLE_DDL);
    this.db.run(WORKFLOWS_REBUILD_INSERT_DDL);
    this.db.run('DROP TABLE workflows');
    this.db.run('ALTER TABLE workflows_new RENAME TO workflows');
    if (foreignKeysEnabled) {
      this.db.run('PRAGMA foreign_keys = ON');
    }
    this.dirty = true;
  }

  /**
   * Rewrite `pnpm test packages/<pkg>/...` (incorrect root-level invocation)
   * to `cd packages/<pkg> && pnpm test -- <relative-path>`.
   * Idempotent: already-rewritten commands won't match the LIKE pattern.
   */
  private migrateTestCommands(): void {
    try {
      const rows = this.queryAll(
        `SELECT id, command FROM tasks WHERE command LIKE 'pnpm test packages/%' OR command LIKE 'pnpm test -- packages/%'`,
      ) as Array<{ id: string; command: string }>;

      for (const row of rows) {
        const fixed = rewritePnpmTestCommand(row.command);
        if (fixed !== row.command) {
          this.execRun('UPDATE tasks SET command = ? WHERE id = ?', [fixed, row.id]);
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
  private migrateGatePolicyApprovedToCompleted(): void {
    try {
      const rows = this.queryAll(
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
            this.execRun('UPDATE tasks SET external_dependencies = ? WHERE id = ?', [updated, row.id]);
          }
        } catch {
          // Skip malformed JSON rows
        }
      }
    } catch {
      // Table may not exist yet on first run
    }
  }

  private normalizeExternalDependencies(raw: unknown): ExternalDependency[] {
    if (!Array.isArray(raw)) return [];
    const normalized: ExternalDependency[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const dep = item as Record<string, unknown>;
      if (typeof dep.workflowId !== 'string' || dep.workflowId.trim() === '') continue;
      const taskId = typeof dep.taskId === 'string' && dep.taskId.trim() !== '' ? dep.taskId.trim() : '__merge__';
      const gatePolicy = dep.gatePolicy === 'review_ready' ? 'review_ready' : 'completed';
      normalized.push({
        workflowId: dep.workflowId.trim(),
        taskId,
        requiredStatus: 'completed',
        gatePolicy,
      });
    }
    return normalized;
  }

  private mergeExternalDependencySets(existing: ExternalDependency[], incoming: ExternalDependency[]): ExternalDependency[] {
    const byKey = new Map<string, ExternalDependency>();
    for (const dep of [...existing, ...incoming]) {
      const taskId = dep.taskId?.trim() || '__merge__';
      const key = `${dep.workflowId}::${taskId}`;
      const previous = byKey.get(key);
      const gatePolicy =
        previous?.gatePolicy === 'completed' || dep.gatePolicy === 'completed'
          ? 'completed'
          : 'review_ready';
      byKey.set(key, {
        workflowId: dep.workflowId,
        taskId,
        requiredStatus: 'completed',
        gatePolicy,
      });
    }
    return Array.from(byKey.values());
  }

  /**
   * Promote legacy per-task external dependencies to workflow metadata.
   * This is intentionally idempotent: once task rows are cleared, later runs
   * only see the workflow-level source of truth.
   */
  private migrateTaskExternalDependenciesToWorkflows(): void {
    try {
      const rows = this.queryAll(
        `SELECT id, workflow_id, external_dependencies FROM tasks WHERE external_dependencies IS NOT NULL AND external_dependencies != ''`,
      ) as Array<{ id: string; workflow_id: string; external_dependencies: string }>;
      if (rows.length === 0) return;

      const incomingByWorkflow = new Map<string, ExternalDependency[]>();
      for (const row of rows) {
        try {
          const deps = this.normalizeExternalDependencies(JSON.parse(row.external_dependencies));
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
        const wf = this.queryOne(
          `SELECT external_dependencies FROM workflows WHERE id = ?`,
          [workflowId],
        ) as { external_dependencies?: string | null } | undefined;
        if (!wf) continue;
        let existing: ExternalDependency[] = [];
        if (wf.external_dependencies) {
          try {
            existing = this.normalizeExternalDependencies(JSON.parse(wf.external_dependencies));
          } catch {
            existing = [];
          }
        }
        const merged = this.mergeExternalDependencySets(existing, incoming);
        this.execRun(
          `UPDATE workflows SET external_dependencies = ?, updated_at = ? WHERE id = ?`,
          [merged.length > 0 ? JSON.stringify(merged) : null, new Date().toISOString(), workflowId],
        );
      }

      this.execRun(
        `UPDATE tasks SET external_dependencies = NULL WHERE external_dependencies IS NOT NULL AND external_dependencies != ''`,
      );
    } catch {
      // Tables/columns may not exist yet on first run.
    }
  }

  // ── Workflows ─────────────────────────────────────────

  saveWorkflow(workflow: WorkflowSaveInput): void {
    this.execRun(`
      INSERT OR REPLACE INTO workflows (id, name, description, visual_proof, plan_file, repo_url, intermediate_repo_url, branch, on_finish, base_branch, parent_remote, feature_branch, merge_mode, review_provider, external_dependencies, external_dependency_changes, detached_external_dependencies, generation, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      workflow.id, workflow.name,
      workflow.description ?? null,
      workflow.visualProof ? 1 : 0,
      workflow.planFile ?? null, workflow.repoUrl ?? null, workflow.intermediateRepoUrl ?? null, workflow.branch ?? null,
      workflow.onFinish ?? null, workflow.baseBranch ?? null, null, workflow.featureBranch ?? null,
      workflow.mergeMode ?? null,
      workflow.reviewProvider ?? null,
      workflow.externalDependencies ? JSON.stringify(workflow.externalDependencies) : null,
      workflow.externalDependencyChanges ? JSON.stringify(workflow.externalDependencyChanges) : null,
      workflow.detachedExternalDependencies ? JSON.stringify(workflow.detachedExternalDependencies) : null,
      workflow.generation ?? 0,
      workflow.createdAt, workflow.updatedAt,
    ]);
  }

  updateWorkflow(workflowId: string, changes: Partial<Pick<Workflow, 'name' | 'description' | 'visualProof' | 'planFile' | 'repoUrl' | 'intermediateRepoUrl' | 'branch' | 'onFinish' | 'baseBranch' | 'featureBranch' | 'mergeMode' | 'reviewProvider' | 'externalDependencies' | 'externalDependencyChanges' | 'detachedExternalDependencies' | 'generation' | 'updatedAt'>>): void {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    const columnMap: Record<string, string> = {
      name: 'name',
      description: 'description',
      planFile: 'plan_file',
      repoUrl: 'repo_url',
      intermediateRepoUrl: 'intermediate_repo_url',
      branch: 'branch',
      onFinish: 'on_finish',
      baseBranch: 'base_branch',
      featureBranch: 'feature_branch',
      mergeMode: 'merge_mode',
      reviewProvider: 'review_provider',
    };
    for (const [key, column] of Object.entries(columnMap)) {
      if (key in changes) {
        setClauses.push(`${column} = ?`);
        values.push((changes as any)[key] ?? null);
      }
    }
    if (changes.visualProof !== undefined) {
      setClauses.push('visual_proof = ?');
      values.push(changes.visualProof ? 1 : 0);
    }
    if (changes.baseBranch !== undefined) {
      // handled by columnMap; kept for backward-compatible patch shapes
    }
    if (changes.generation !== undefined) {
      setClauses.push('generation = ?');
      values.push(changes.generation);
    }
    if (changes.mergeMode !== undefined) {
      // handled by columnMap; kept for backward-compatible patch shapes
    }
    // Presence semantics (matching updateTask's config.externalDependencies):
    // key present with undefined ⇒ clear the column; key absent ⇒ unchanged.
    // detachWorkflowInternal clears a dependent's last dependency by passing
    // `externalDependencies: undefined` — a skip-if-undefined check here left
    // dangling dependencies behind after upstream workflow deletion.
    if ('externalDependencies' in changes) {
      setClauses.push('external_dependencies = ?');
      values.push(changes.externalDependencies ? JSON.stringify(changes.externalDependencies) : null);
    }
    if ('externalDependencyChanges' in changes) {
      setClauses.push('external_dependency_changes = ?');
      values.push(changes.externalDependencyChanges ? JSON.stringify(changes.externalDependencyChanges) : null);
    }
    if ('detachedExternalDependencies' in changes) {
      setClauses.push('detached_external_dependencies = ?');
      values.push(changes.detachedExternalDependencies ? JSON.stringify(changes.detachedExternalDependencies) : null);
    }
    setClauses.push('updated_at = ?');
    values.push(changes.updatedAt ?? new Date().toISOString());
    if (setClauses.length === 0) return;
    values.push(workflowId);
    this.execRun(`UPDATE workflows SET ${setClauses.join(', ')} WHERE id = ?`, values);
  }

  loadWorkflow(workflowId: string): Workflow | undefined {
    const row = this.queryOne('SELECT * FROM workflows WHERE id = ?', [workflowId]);
    if (!row) return undefined;
    const rollup = this.loadWorkflowRollups([workflowId]).get(workflowId);
    return this.rowToWorkflow(row, rollup);
  }

  listWorkflows(): Workflow[] {
    const rows = this.queryAll(
      'SELECT * FROM workflows ORDER BY created_at DESC',
    );
    const workflowIds = rows.map((row: any) => String(row.id));
    const rollups = this.loadWorkflowRollups(workflowIds);
    return rows.map((row: any) => this.rowToWorkflow(row, rollups.get(String(row.id))));
  }

  searchWorkflowsAndTasks(query: string, opts?: SearchOptions): SearchResultItem[] {
    if (!query.trim()) {
      return [];
    }
    const safeQuery = `%${query.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
    const type = opts?.type ?? 'all';
    const limit = Math.min(opts?.limit ?? 20, 50);
    const offset = opts?.offset ?? 0;
    
    const results: SearchResultItem[] = [];
    
    if (type === 'workflows' || type === 'all') {
      const workflows = this.queryAll(
        `SELECT id, name, description, plan_file, repo_url, branch, created_at FROM workflows 
         WHERE name LIKE ? OR description LIKE ? OR plan_file LIKE ? OR repo_url LIKE ? OR branch LIKE ? 
         LIMIT ? OFFSET ?`,
        [safeQuery, safeQuery, safeQuery, safeQuery, safeQuery, limit, offset]
      ) as Array<{ id: string; name?: string | null; created_at: string }>;
      // Batch load rollups for status
      const workflowIds = workflows.map((row) => row.id);
      const rollups = workflowIds.length > 0 ? this.loadWorkflowRollups(workflowIds) : new Map();
      for (const row of workflows) {
        const rollup = rollups.get(row.id);
        const status = rollup?.status ?? 'pending';
        results.push({
          kind: 'workflow',
          id: row.id,
          workflowId: undefined,
          title: row.name || 'Unnamed workflow',
          subtitle: `Workflow · ${status}`,
          status,
          createdAt: row.created_at,
        });
      }
    }
    
    if (type === 'tasks' || type === 'all') {
      const tasks = this.queryAll(
        `SELECT id, workflow_id, description, command, prompt, summary, problem, approach, test_plan, repro_command, status, created_at FROM tasks 
         WHERE description LIKE ? OR command LIKE ? OR prompt LIKE ? OR summary LIKE ? OR problem LIKE ? OR approach LIKE ? OR test_plan LIKE ? OR repro_command LIKE ? 
         LIMIT ? OFFSET ?`,
        [safeQuery, safeQuery, safeQuery, safeQuery, safeQuery, safeQuery, safeQuery, safeQuery, limit, offset]
      ) as Array<{
        id: string;
        workflow_id?: string | null;
        description?: string | null;
        status?: string | null;
        created_at: string;
      }>;
      // Map workflow IDs to names for subtitle
      const workflowIds = [...new Set(tasks.map((task) => task.workflow_id).filter((id): id is string => typeof id === 'string' && id.length > 0))];
      const workflowNameMap = new Map<string, string>();
      if (workflowIds.length > 0) {
        const placeholders = workflowIds.map(() => '?').join(',');
        const workflowRows = this.queryAll(
          `SELECT id, name FROM workflows WHERE id IN (${placeholders})`,
          workflowIds
        ) as Array<{ id: string; name?: string | null }>;
        for (const wf of workflowRows) {
          workflowNameMap.set(wf.id, wf.name || 'Unnamed workflow');
        }
      }
      for (const row of tasks) {
        const workflowName = row.workflow_id ? workflowNameMap.get(row.workflow_id) : undefined;
        results.push({
          kind: 'task',
          id: row.id,
          workflowId: row.workflow_id || undefined,
          title: row.description || 'Unnamed task',
          subtitle: workflowName ? `Task · ${workflowName}` : '',
          status: row.status || '',
          createdAt: row.created_at,
        });
      }
    }
    
    // Return workflows first, then tasks (preserving order within each category)
    return results;
  }

  loadWorkflowTaskSnapshot(): WorkflowTaskSnapshot {
    const totalStartedAt = Date.now();
    const workflowQueryStartedAt = Date.now();
    const workflowRows = this.queryAll('SELECT * FROM workflows ORDER BY created_at DESC');
    const workflowMetadataQueryMs = Date.now() - workflowQueryStartedAt;
    const taskQueryStartedAt = Date.now();
    const taskRows = this.queryAll('SELECT * FROM tasks ORDER BY workflow_id ASC, id ASC');
    const taskQueryMs = Date.now() - taskQueryStartedAt;
    const tasksByWorkflowId = new Map<string, TaskState[]>();
    const workflowIds = workflowRows.map((row: any) => String(row.id));
    const rollupStartedAt = Date.now();
    const rollups = this.computeWorkflowRollupsFromRows(workflowIds, taskRows);
    const rollupComputationMs = Date.now() - rollupStartedAt;
    const tasks: TaskState[] = [];

    const deserializeStartedAt = Date.now();
    for (const row of taskRows) {
      const task = this.reconcileTaskFromSelectedAttempt(this.rowToTask(row));
      tasks.push(task);
      const workflowId = task.config.workflowId ?? '';
      if (!workflowId) continue;
      const workflowTasks = tasksByWorkflowId.get(workflowId) ?? [];
      workflowTasks.push(task);
      tasksByWorkflowId.set(workflowId, workflowTasks);
    }
    const taskDeserializeReconcileMs = Date.now() - deserializeStartedAt;

    const snapshot = {
      workflows: workflowRows.map((row: any) => this.rowToWorkflow(row, rollups.get(String(row.id)))),
      tasks,
      tasksByWorkflowId,
    };
    this.lastWorkflowTaskSnapshotStats = {
      workflowMetadataQueryMs,
      taskQueryMs,
      rollupComputationMs,
      taskDeserializeReconcileMs,
      totalMs: Date.now() - totalStartedAt,
      workflowCount: snapshot.workflows.length,
      taskCount: tasks.length,
    };
    return snapshot;
  }

  getLastWorkflowTaskSnapshotStats(): Record<string, unknown> | null {
    return this.lastWorkflowTaskSnapshotStats ? { ...this.lastWorkflowTaskSnapshotStats } : null;
  }

  // ── Tasks ─────────────────────────────────────────────

  saveTask(workflowId: string, task: TaskState): void {
    const cfg = task.config;
    const exec = task.execution;
    this.execRun(`
      INSERT OR REPLACE INTO tasks (
        id, workflow_id, description, status, blocked_by, dependencies,
        command, prompt, experiment_prompt, exit_code, error, protocol_error_code, protocol_error_message, input_prompt, external_dependencies,
        summary, problem, approach, test_plan, repro_command, fix_prompt, fix_context,
        branch, commit_hash, fixed_integration_sha, fixed_integration_recorded_at, fixed_integration_source, parent_task,
        pivot, experiment_variants, is_reconciliation, selected_experiment,
        selected_experiments, experiment_results, requires_manual_approval,
        repo_url, feature_branch,
        is_merge_node, auto_fix, max_fix_attempts,
        runner_kind, pool_id, agent_session_id, workspace_path, container_id,
        last_agent_session_id, last_agent_name,
        action_request_id, experiments,
        created_at, launch_phase, launch_started_at, launch_completed_at, started_at, completed_at, last_heartbeat_at,
        utilization, pending_fix_error,
        review_url, review_id, review_status, review_provider_id, review_gate,
        is_fixing_with_ai,
        execution_generation,
        pool_member_id,
        docker_image,
        execution_agent,
        agent_name,
        task_state_version
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?,
        ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?
      )
    `, [
      task.id, workflowId, task.description, task.status,
      exec.blockedBy ?? null,
      JSON.stringify(task.dependencies),
      cfg.command ?? null, cfg.prompt ?? null, cfg.experimentPrompt ?? null,
      exec.exitCode ?? null, exec.error ?? null, exec.protocolErrorCode ?? null, exec.protocolErrorMessage ?? null, exec.inputPrompt ?? null,
      null,
      cfg.summary ?? null, cfg.problem ?? null, cfg.approach ?? null,
      cfg.testPlan ?? null, cfg.reproCommand ?? null, cfg.fixPrompt ?? null, cfg.fixContext ?? null,
      exec.branch ?? null,
      exec.commit ?? null,
      exec.fixedIntegrationSha ?? null,
      exec.fixedIntegrationRecordedAt?.toISOString() ?? null,
      exec.fixedIntegrationSource ?? null,
      cfg.parentTask ?? null,
      cfg.pivot ? 1 : 0,
      cfg.experimentVariants ? JSON.stringify(cfg.experimentVariants) : null,
      cfg.isReconciliation ? 1 : 0,
      exec.selectedExperiment ?? null,
      exec.selectedExperiments ? JSON.stringify(exec.selectedExperiments) : null,
      exec.experimentResults ? JSON.stringify(exec.experimentResults) : null,
      cfg.requiresManualApproval ? 1 : 0,
      null, cfg.featureBranch ?? null,
      cfg.isMergeNode ? 1 : 0,
      0, null,
      cfg.runnerKind ?? null,
      cfg.poolId ?? null,
      exec.agentSessionId ?? null,
      exec.workspacePath ?? null,
      exec.containerId ?? null,
      exec.lastAgentSessionId ?? null,
      exec.lastAgentName ?? null,
      exec.actionRequestId ?? null,
      exec.experiments ? JSON.stringify(exec.experiments) : null,
      task.createdAt.toISOString(),
      exec.phase ?? null,
      exec.launchStartedAt?.toISOString() ?? null,
      exec.launchCompletedAt?.toISOString() ?? null,
      exec.startedAt?.toISOString() ?? null,
      exec.completedAt?.toISOString() ?? null,
      exec.lastHeartbeatAt?.toISOString() ?? null,
      null,
      exec.pendingFixError ?? null,
      exec.reviewUrl ?? null,
      exec.reviewId ?? null,
      exec.reviewStatus ?? null,
      exec.reviewProviderId ?? null,
      exec.reviewGate ? JSON.stringify(exec.reviewGate) : null,
      exec.isFixingWithAI ? 1 : 0,
      exec.generation ?? 0,
      (cfg as { poolMemberId?: string }).poolMemberId ?? null,
      cfg.dockerImage ?? null,
      cfg.executionAgent ?? null,
      exec.agentName ?? null,
      task.taskStateVersion ?? 1,
    ]);
  }

  updateTask(taskId: string, changes: TaskStateChanges): void {
    const setClauses: string[] = [];
    const values: any[] = [];

    if (changes.description !== undefined) {
      setClauses.push('description = ?');
      values.push(changes.description);
    }
    if (changes.status !== undefined) {
      setClauses.push('status = ?');
      values.push(changes.status);
    }
    if (changes.dependencies !== undefined) {
      setClauses.push('dependencies = ?');
      values.push(JSON.stringify(changes.dependencies));
    }

    if (changes.config) {
      const configMap: Record<string, string> = {
        workflowId: 'workflow_id',
        parentTask: 'parent_task',
        command: 'command',
        prompt: 'prompt',
        experimentPrompt: 'experiment_prompt',
        summary: 'summary',
        problem: 'problem',
        approach: 'approach',
        testPlan: 'test_plan',
        reproCommand: 'repro_command',
        featureBranch: 'feature_branch',
        runnerKind: 'runner_kind',
        poolId: 'pool_id',
        poolMemberId: 'pool_member_id',
        dockerImage: 'docker_image',
        executionAgent: 'execution_agent',
        fixPrompt: 'fix_prompt',
        fixContext: 'fix_context',
      };
      const configBoolMap: Record<string, string> = {
        pivot: 'pivot',
        isReconciliation: 'is_reconciliation',
        requiresManualApproval: 'requires_manual_approval',
        isMergeNode: 'is_merge_node',
      };

      for (const [key, col] of Object.entries(configMap)) {
        if (key in changes.config) {
          setClauses.push(`${col} = ?`);
          values.push((changes.config as any)[key] ?? null);
        }
      }
      for (const [key, col] of Object.entries(configBoolMap)) {
        if (key in changes.config) {
          setClauses.push(`${col} = ?`);
          values.push((changes.config as any)[key] ? 1 : 0);
        }
      }
      if ('experimentVariants' in changes.config) {
        setClauses.push('experiment_variants = ?');
        values.push(changes.config.experimentVariants ? JSON.stringify(changes.config.experimentVariants) : null);
      }
      if ('externalDependencies' in changes.config) {
        setClauses.push('external_dependencies = ?');
        values.push(changes.config.externalDependencies ? JSON.stringify(changes.config.externalDependencies) : null);
      }
    }

    if (changes.execution) {
      const execMap: Record<string, string> = {
        blockedBy: 'blocked_by',
        inputPrompt: 'input_prompt',
        exitCode: 'exit_code',
        error: 'error',
        protocolErrorCode: 'protocol_error_code',
        protocolErrorMessage: 'protocol_error_message',
        actionRequestId: 'action_request_id',
        branch: 'branch',
        commit: 'commit_hash',
        fixedIntegrationSha: 'fixed_integration_sha',
        fixedIntegrationSource: 'fixed_integration_source',
        agentSessionId: 'agent_session_id',
        lastAgentSessionId: 'last_agent_session_id',
        workspacePath: 'workspace_path',
        containerId: 'container_id',
        selectedExperiment: 'selected_experiment',
        pendingFixError: 'pending_fix_error',
        reviewUrl: 'review_url',
        reviewId: 'review_id',
        reviewStatus: 'review_status',
        reviewProviderId: 'review_provider_id',
        phase: 'launch_phase',
        generation: 'execution_generation',
        selectedAttemptId: 'selected_attempt_id',
        agentName: 'agent_name',
        lastAgentName: 'last_agent_name',
        autoFixAttempts: 'auto_fix_attempts',
      };
      const execDateMap: Record<string, string> = {
        startedAt: 'started_at',
        completedAt: 'completed_at',
        lastHeartbeatAt: 'last_heartbeat_at',
        launchStartedAt: 'launch_started_at',
        launchCompletedAt: 'launch_completed_at',
        fixedIntegrationRecordedAt: 'fixed_integration_recorded_at',
      };
      const execJsonFields: Record<string, string> = {
        experiments: 'experiments',
        selectedExperiments: 'selected_experiments',
        experimentResults: 'experiment_results',
        reviewGate: 'review_gate',
      };

      for (const [key, col] of Object.entries(execMap)) {
        if (key in changes.execution) {
          setClauses.push(`${col} = ?`);
          values.push((changes.execution as any)[key] ?? null);
        }
      }
      for (const [key, col] of Object.entries(execDateMap)) {
        if (key in changes.execution) {
          setClauses.push(`${col} = ?`);
          const val = (changes.execution as any)[key];
          values.push(val instanceof Date ? val.toISOString() : val ?? null);
        }
      }
      for (const [key, col] of Object.entries(execJsonFields)) {
        if (key in changes.execution) {
          setClauses.push(`${col} = ?`);
          const val = (changes.execution as any)[key];
          values.push(val ? JSON.stringify(val) : null);
        }
      }
      const execBoolMap: Record<string, string> = {
        isFixingWithAI: 'is_fixing_with_ai',
      };
      for (const [key, col] of Object.entries(execBoolMap)) {
        if (key in changes.execution) {
          setClauses.push(`${col} = ?`);
          values.push((changes.execution as any)[key] ? 1 : 0);
        }
      }
    }

    if (setClauses.length === 0) return;

    // Atomically bump task-state version with every mutation
    setClauses.push('task_state_version = task_state_version + 1');

    if (changes.execution && 'workspacePath' in changes.execution) {
      try {
        const row = this.queryOne(
          'SELECT is_merge_node AS isMerge, workspace_path AS prevPath FROM tasks WHERE id = ?',
          [taskId],
        ) as { isMerge?: number; prevPath?: string | null } | undefined;
        if (row?.isMerge === 1) {
          const nextWs = (changes.execution as { workspacePath?: string }).workspacePath;
          console.log(
            `[merge-gate-workspace] sqlite.updateTask mergeNode task=${taskId} ` +
              `workspace_path ${row.prevPath ?? 'NULL'} → ${nextWs ?? 'NULL'} ` +
              '(caller sets executor worktree path and/or gate clone path)',
          );
        }
      } catch {
        /* best-effort diagnostics only */
      }
    }

    values.push(taskId);
    const heartbeatOnly =
      setClauses.length === 1 && setClauses[0].trimStart().startsWith('last_heartbeat_at =');
    if (!heartbeatOnly && process.env.NODE_ENV !== 'test' && process.env.INVOKER_TRACE_PERSIST_SQL === '1') {
      const cols = setClauses.map((c) => c.split(/\s*=\s*/)[0]!.trim()).join(', ');
      console.log(`[persist-sql] taskId=${taskId} columns=[${cols}]`);
    }
    this.execRun(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`, values);
  }

  loadTasks(workflowId: string): TaskState[] {
    const rows = this.queryAll('SELECT * FROM tasks WHERE workflow_id = ?', [workflowId]);
    return rows.map((row) => this.reconcileTaskFromSelectedAttempt(this.rowToTask(row)));
  }

  loadTask(taskId: string): TaskState | undefined {
    const row = this.queryOne('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (!row) return undefined;
    return this.reconcileTaskFromSelectedAttempt(this.rowToTask(row));
  }

  getAllTaskIds(): string[] {
    const rows = this.queryAll('SELECT id FROM tasks') as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  getAllTaskBranches(): string[] {
    const rows = this.queryAll(
      'SELECT DISTINCT branch FROM tasks WHERE branch IS NOT NULL',
    ) as Array<{ branch: string }>;
    return rows.map((r) => r.branch);
  }

  private getTaskIdsForWorkflow(workflowId: string): string[] {
    const rows = this.queryAll(
      'SELECT id FROM tasks WHERE workflow_id = ?',
      [workflowId],
    ) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  private invalidateOutputTailCache(taskIds: string[]): void {
    for (const taskId of taskIds) {
      this.outputTailCache.delete(taskId);
      this.spoolNextOffsetCache.delete(taskId);
    }
  }

  private taskOutputKey(taskId: string): string {
    return createHash('sha256').update(taskId).digest('hex');
  }

  private taskOutputFile(taskId: string): string {
    return join(this.outputDir, 'full', `${this.taskOutputKey(taskId)}.log`);
  }

  private taskSpoolFile(taskId: string): string {
    return join(this.outputDir, 'spool', `${this.taskOutputKey(taskId)}.jsonl`);
  }

  private ensureOutputSubdir(kind: 'full' | 'spool'): void {
    mkdirSync(join(this.outputDir, kind), { recursive: true });
  }

  private removeOutputFiles(taskIds: string[]): void {
    for (const taskId of taskIds) {
      rmSync(this.taskOutputFile(taskId), { force: true });
      rmSync(this.taskSpoolFile(taskId), { force: true });
    }
    this.invalidateOutputTailCache(taskIds);
  }

  private readTaskOutputFile(taskId: string): string {
    const file = this.taskOutputFile(taskId);
    if (!existsSync(file)) return '';
    return readFileSync(file, 'utf8');
  }

  private encodeSpoolLine(chunk: OutputChunk): string {
    const data = Buffer.from(chunk.data, 'utf8').toString('base64');
    return `${chunk.offset}\t${data}\n`;
  }

  private decodeSpoolLine(line: string): OutputChunk | null {
    if (!line) return null;
    const separator = line.indexOf('\t');
    if (separator <= 0) return null;
    const offset = Number.parseInt(line.slice(0, separator), 10);
    if (!Number.isFinite(offset)) return null;
    return {
      offset,
      data: Buffer.from(line.slice(separator + 1), 'base64').toString('utf8'),
    };
  }

  private readSpoolLines(taskId: string): OutputChunk[] {
    const file = this.taskSpoolFile(taskId);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => this.decodeSpoolLine(line))
      .filter((chunk): chunk is OutputChunk => chunk !== null);
  }

  private readLastSpoolLines(taskId: string, limit: number): OutputChunk[] {
    if (limit <= 0) return [];
    const file = this.taskSpoolFile(taskId);
    if (!existsSync(file)) return [];

    const fd = openSync(file, 'r');
    try {
      const size = statSync(file).size;
      const chunkSize = 64 * 1024;
      let position = size;
      let suffix = '';
      let lines: string[] = [];

      while (position > 0 && lines.length <= limit) {
        const readSize = Math.min(chunkSize, position);
        position -= readSize;
        const buffer = Buffer.allocUnsafe(readSize);
        readSync(fd, buffer, 0, readSize, position);
        const text = buffer.toString('utf8') + suffix;
        const parts = text.split('\n');
        suffix = parts.shift() ?? '';
        lines = parts.concat(lines);
      }
      if (position === 0 && suffix) {
        lines.unshift(suffix);
      }

      return lines
        .filter(Boolean)
        .slice(-limit)
        .map((line) => this.decodeSpoolLine(line))
        .filter((chunk): chunk is OutputChunk => chunk !== null);
    } finally {
      closeSync(fd);
    }
  }

  private readLastSpoolChunk(taskId: string): OutputChunk | null {
    return this.readLastSpoolLines(taskId, 1)[0] ?? null;
  }

  private getLegacySpoolChunks(taskId: string): OutputChunk[] {
    const rows = this.queryAll(
      'SELECT offset, data FROM output_spool WHERE task_id = ? ORDER BY offset ASC',
      [taskId],
    ) as Array<{ offset: number; data: string }>;

    return rows.map((row) => ({ offset: row.offset, data: row.data }));
  }

  private getLegacySpoolEndOffset(taskId: string): number {
    const row = this.queryOne(
      'SELECT offset, data FROM output_spool WHERE task_id = ? ORDER BY offset DESC LIMIT 1',
      [taskId],
    ) as { offset: number; data: string } | undefined;
    if (!row) return 0;
    return row.offset + Buffer.byteLength(row.data, 'utf8');
  }

  private getNextSpoolOffset(taskId: string): number {
    const cached = this.spoolNextOffsetCache.get(taskId);
    if (cached !== undefined) return cached;

    const legacyEnd = this.getLegacySpoolEndOffset(taskId);
    const fileLast = this.readLastSpoolChunk(taskId);
    const fileEnd = fileLast ? fileLast.offset + Buffer.byteLength(fileLast.data, 'utf8') : 0;
    const nextOffset = Math.max(legacyEnd, fileEnd);
    this.spoolNextOffsetCache.set(taskId, nextOffset);
    return nextOffset;
  }

  loadAllCompletedTasks(): Array<TaskState & { workflowName: string }> {
    const rows = this.queryAll(`
      SELECT t.*, w.name AS workflow_name
      FROM tasks t
      JOIN workflows w ON w.id = t.workflow_id
      WHERE t.status = 'completed'
      ORDER BY t.completed_at DESC
    `);
    return rows.map((row: any) => ({
      ...this.rowToTask(row),
      workflowName: row.workflow_name,
    }));
  }

  deleteAllTasks(workflowId: string): void {
    const taskIds = this.getTaskIdsForWorkflow(workflowId);
    this.runTransaction(() => {
      this.db.run('DELETE FROM workflow_mutation_leases WHERE workflow_id = ?', [workflowId]);
      this.db.run('DELETE FROM workflow_mutation_intents WHERE workflow_id = ?', [workflowId]);
      this.db.run('DELETE FROM task_launch_dispatch WHERE workflow_id = ?', [workflowId]);
      this.db.run(`
        DELETE FROM execution_resource_leases WHERE task_id IN (
          SELECT id FROM tasks WHERE workflow_id = ?
        )
      `, [workflowId]);
      this.db.run(`
        DELETE FROM events WHERE task_id IN (
          SELECT id FROM tasks WHERE workflow_id = ?
        )
      `, [workflowId]);
      this.db.run(`
        DELETE FROM task_output WHERE task_id IN (
          SELECT id FROM tasks WHERE workflow_id = ?
        )
      `, [workflowId]);
      this.db.run(`
        DELETE FROM attempts WHERE node_id IN (
          SELECT id FROM tasks WHERE workflow_id = ?
        )
      `, [workflowId]);
      this.db.run(`
        DELETE FROM output_spool WHERE task_id IN (
          SELECT id FROM tasks WHERE workflow_id = ?
        )
      `, [workflowId]);
      this.db.run('DELETE FROM tasks WHERE workflow_id = ?', [workflowId]);
    });
    this.removeOutputFiles(taskIds);
  }

  deleteAllWorkflows(): void {
    const taskIds = this.getAllTaskIds();
    this.runTransaction(() => {
      this.db.run('DELETE FROM workflow_mutation_leases');
      this.db.run('DELETE FROM workflow_mutation_intents');
      this.db.run('DELETE FROM task_launch_dispatch');
      this.db.run('DELETE FROM execution_resource_leases');
      this.db.run('DELETE FROM events');
      this.db.run('DELETE FROM task_output');
      this.db.run('DELETE FROM attempts');
      this.db.run('DELETE FROM output_spool');
      this.db.run('DELETE FROM tasks');
      this.db.run('DELETE FROM workflows');
    });
    this.removeOutputFiles(taskIds);
    this.outputTailCache.clear();
    this.spoolNextOffsetCache.clear();
  }

  deleteWorkflow(workflowId: string): void {
    const taskIds = this.getTaskIdsForWorkflow(workflowId);
    this.runTransaction(() => {
      this.db.run('DELETE FROM workflow_mutation_leases WHERE workflow_id = ?', [workflowId]);
      this.db.run('DELETE FROM workflow_mutation_intents WHERE workflow_id = ?', [workflowId]);
      this.db.run('DELETE FROM task_launch_dispatch WHERE workflow_id = ?', [workflowId]);
      this.db.run(`
        DELETE FROM execution_resource_leases WHERE task_id IN (
          SELECT id FROM tasks WHERE workflow_id = ?
        )
      `, [workflowId]);

      this.db.run(`
        DELETE FROM events WHERE task_id IN (
          SELECT id FROM tasks WHERE workflow_id = ?
        )
      `, [workflowId]);

      this.db.run(`
        DELETE FROM task_output WHERE task_id IN (
          SELECT id FROM tasks WHERE workflow_id = ?
        )
      `, [workflowId]);

      this.db.run(`
        DELETE FROM attempts WHERE node_id IN (
          SELECT id FROM tasks WHERE workflow_id = ?
        )
      `, [workflowId]);

      this.db.run(`
        DELETE FROM output_spool WHERE task_id IN (
          SELECT id FROM tasks WHERE workflow_id = ?
        )
      `, [workflowId]);

      this.db.run('DELETE FROM tasks WHERE workflow_id = ?', [workflowId]);

      this.db.run('DELETE FROM workflows WHERE id = ?', [workflowId]);
    });
    this.removeOutputFiles(taskIds);
  }

  // ── Events ────────────────────────────────────────────

  logEvent(taskId: string, eventType: string, payload?: unknown): void {
    this.execRun(`
      INSERT INTO events (task_id, event_type, payload)
      VALUES (?, ?, ?)
    `, [taskId, eventType, payload ? JSON.stringify(payload) : null]);
  }

  getEvents(taskId: string): TaskEvent[];
  getEvents(taskId: string, sortBy: 'asc' | 'desc', limit: number): TaskEvent[];
  getEvents(taskId: string, sortBy: 'asc' | 'desc' = 'asc', limit?: number): TaskEvent[] {
    const orderBy = sortBy === 'desc' ? 'DESC' : 'ASC';
    const rows = limit === undefined
      ? this.queryAll(
        `SELECT * FROM events WHERE task_id = ? ORDER BY id ${orderBy}`,
        [taskId],
      )
      : limit <= 0
        ? []
        : this.queryAll(
          `SELECT * FROM events WHERE task_id = ? ORDER BY id ${orderBy} LIMIT ?`,
          [taskId, Math.floor(limit)],
        );
    return rows.map((row: any) => ({
      id: row.id,
      taskId: row.task_id,
      eventType: row.event_type,
      payload: row.payload ?? undefined,
      createdAt: row.created_at,
    }));
  }

  // ── Queries ─────────────────────────────────────────

  getSelectedExperiment(taskId: string): string | null {
    const row = this.queryOne(
      'SELECT selected_experiment FROM tasks WHERE id = ?',
      [taskId],
    );
    return (row?.selected_experiment as string) ?? null;
  }

  getWorkspacePath(taskId: string): string | null {
    const row = this.queryOne(
      'SELECT workspace_path FROM tasks WHERE id = ?',
      [taskId],
    );
    return (row?.workspace_path as string) ?? null;
  }

  getAgentSessionId(taskId: string): string | null {
    const row = this.queryOne(
      'SELECT agent_session_id, last_agent_session_id FROM tasks WHERE id = ?',
      [taskId],
    );
    const val = ((row?.agent_session_id as string) ?? (row?.last_agent_session_id as string) ?? null);
    return val === 'none' ? null : val;
  }

  getLastAgentSessionId(taskId: string): string | null {
    const row = this.queryOne(
      'SELECT last_agent_session_id FROM tasks WHERE id = ?',
      [taskId],
    );
    const val = (row?.last_agent_session_id as string) ?? null;
    return val === 'none' ? null : val;
  }

  getRunnerKind(taskId: string): string | null {
    const row = this.queryOne(
      'SELECT runner_kind FROM tasks WHERE id = ?',
      [taskId],
    );
    const raw = (row?.runner_kind as string) ?? null;
    if (raw === null) return null;
    return normalizeRunnerKind(raw) ?? raw;
  }

  getTaskStatus(taskId: string): string | null {
    const row = this.queryOne(
      'SELECT status FROM tasks WHERE id = ?',
      [taskId],
    ) as { status?: string } | undefined;
    if (!row?.status) return null;
    return row.status;
  }

  getContainerId(taskId: string): string | null {
    const row = this.queryOne(
      'SELECT container_id FROM tasks WHERE id = ?',
      [taskId],
    );
    const val = (row?.container_id as string) ?? null;
    return val === 'none' ? null : val;
  }

  getBranch(taskId: string): string | null {
    const row = this.queryOne(
      'SELECT branch FROM tasks WHERE id = ?',
      [taskId],
    );
    return (row?.branch as string) ?? null;
  }

  getExecutionAgent(taskId: string): string | null {
    const row = this.queryOne(
      `
      SELECT
        CASE
          WHEN prompt IS NOT NULL AND TRIM(prompt) != '' THEN COALESCE(execution_agent, agent_name, last_agent_name)
          ELSE COALESCE(agent_name, last_agent_name, execution_agent)
        END AS agent
      FROM tasks
      WHERE id = ?
      `,
      [taskId],
    );
    return (row?.agent as string) ?? null;
  }

  getPoolMemberId(taskId: string): string | null {
    const row = this.queryOne(
      'SELECT pool_member_id FROM tasks WHERE id = ?',
      [taskId],
    );
    return (row?.pool_member_id as string) ?? null;
  }

  // ── Conversations ───────────────────────────────────────

  saveConversation(conversation: Conversation): void {
    this.execRun(`
      INSERT OR REPLACE INTO conversations (thread_ts, channel_id, user_id, extracted_plan, plan_submitted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      conversation.threadTs,
      conversation.channelId,
      conversation.userId,
      conversation.extractedPlan,
      conversation.planSubmitted ? 1 : 0,
      conversation.createdAt,
      conversation.updatedAt,
    ]);
  }

  loadConversation(threadTs: string): Conversation | undefined {
    const row = this.queryOne('SELECT * FROM conversations WHERE thread_ts = ?', [threadTs]);
    if (!row) return undefined;
    return {
      threadTs: row.thread_ts as string,
      channelId: row.channel_id as string,
      userId: row.user_id as string,
      extractedPlan: (row.extracted_plan as string) ?? null,
      planSubmitted: row.plan_submitted === 1,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  updateConversation(threadTs: string, changes: Partial<Pick<Conversation, 'extractedPlan' | 'planSubmitted' | 'updatedAt'>>): void {
    const setClauses: string[] = [];
    const values: any[] = [];

    if ('extractedPlan' in changes) {
      setClauses.push('extracted_plan = ?');
      values.push(changes.extractedPlan ?? null);
    }
    if ('planSubmitted' in changes) {
      setClauses.push('plan_submitted = ?');
      values.push(changes.planSubmitted ? 1 : 0);
    }

    // Always bump updated_at
    setClauses.push('updated_at = ?');
    values.push(changes.updatedAt ?? new Date().toISOString());

    if (setClauses.length === 0) return;
    values.push(threadTs);
    this.execRun(`UPDATE conversations SET ${setClauses.join(', ')} WHERE thread_ts = ?`, values);
  }

  deleteConversation(threadTs: string): void {
    this.execRun('DELETE FROM conversation_messages WHERE thread_ts = ?', [threadTs]);
    this.execRun('DELETE FROM conversations WHERE thread_ts = ?', [threadTs]);
  }

  listActiveConversations(): Conversation[] {
    const rows = this.queryAll(
      'SELECT * FROM conversations WHERE plan_submitted = 0 ORDER BY updated_at DESC',
    );
    return rows.map((row: any) => ({
      threadTs: row.thread_ts as string,
      channelId: row.channel_id as string,
      userId: row.user_id as string,
      extractedPlan: (row.extracted_plan as string) ?? null,
      planSubmitted: row.plan_submitted === 1,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }));
  }

  deleteConversationsOlderThan(cutoffIso: string): number {
    this.ensureWritable();
    // Delete messages first (FK constraint)
    this.db.run(`
      DELETE FROM conversation_messages WHERE thread_ts IN (
        SELECT thread_ts FROM conversations WHERE updated_at < ?
      )
    `, [cutoffIso]);
    this.db.run(
      'DELETE FROM conversations WHERE updated_at < ?',
      [cutoffIso],
    );
    const changes = this.db.getRowsModified();
    this.dirty = true;
    return changes;
  }

  // ── Conversation Messages ──────────────────────────────

  appendMessage(threadTs: string, role: 'user' | 'assistant', content: string): void {
    const row = this.queryOne(
      'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM conversation_messages WHERE thread_ts = ?',
      [threadTs],
    ) as { max_seq: number } | undefined;
    const nextSeq = ((row?.max_seq as number) ?? 0) + 1;

    this.execRun(`
      INSERT INTO conversation_messages (thread_ts, seq, role, content)
      VALUES (?, ?, ?, ?)
    `, [threadTs, nextSeq, role, content]);
  }

  loadMessages(threadTs: string): ConversationMessage[] {
    const rows = this.queryAll(
      'SELECT * FROM conversation_messages WHERE thread_ts = ? ORDER BY seq ASC',
      [threadTs],
    );
    return rows.map((row: any) => ({
      id: row.id,
      threadTs: row.thread_ts,
      seq: row.seq,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  // ── Workflow Channels (Slack workflow↔channel mapping) ──

  saveWorkflowChannel(rec: WorkflowChannel): void {
    this.execRun(`
      INSERT OR REPLACE INTO workflow_channels
        (workflow_id, channel_id, requested_by, lobby_channel_id, lobby_thread_ts, harness_preset, repo_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      rec.workflowId,
      rec.channelId,
      rec.requestedBy ?? null,
      rec.lobbyChannelId ?? null,
      rec.lobbyThreadTs ?? null,
      rec.harnessPreset ?? null,
      rec.repoUrl ?? null,
      rec.createdAt,
    ]);
  }

  private mapWorkflowChannelRow(row: any): WorkflowChannel {
    return {
      workflowId: row.workflow_id as string,
      channelId: row.channel_id as string,
      requestedBy: (row.requested_by as string) ?? undefined,
      lobbyChannelId: (row.lobby_channel_id as string) ?? undefined,
      lobbyThreadTs: (row.lobby_thread_ts as string) ?? undefined,
      harnessPreset: (row.harness_preset as string) ?? undefined,
      repoUrl: (row.repo_url as string) ?? undefined,
      createdAt: row.created_at as string,
    };
  }

  loadWorkflowChannelByWorkflowId(workflowId: string): WorkflowChannel | undefined {
    const row = this.queryOne('SELECT * FROM workflow_channels WHERE workflow_id = ?', [workflowId]);
    return row ? this.mapWorkflowChannelRow(row) : undefined;
  }

  loadWorkflowChannelByChannelId(channelId: string): WorkflowChannel | undefined {
    const row = this.queryOne('SELECT * FROM workflow_channels WHERE channel_id = ?', [channelId]);
    return row ? this.mapWorkflowChannelRow(row) : undefined;
  }

  listWorkflowChannels(): WorkflowChannel[] {
    const rows = this.queryAll('SELECT * FROM workflow_channels ORDER BY created_at DESC');
    return rows.map((row: any) => this.mapWorkflowChannelRow(row));
  }

  deleteWorkflowChannel(workflowId: string): void {
    this.execRun('DELETE FROM workflow_channels WHERE workflow_id = ?', [workflowId]);
  }

  // ── Task Output ─────────────────────────────────────

  appendTaskOutput(taskId: string, data: string): void {
    this.ensureWritable();
    this.ensureOutputSubdir('full');
    appendFileSync(this.taskOutputFile(taskId), data, 'utf8');
  }

  getTaskOutput(taskId: string): string {
    // Prefer the output spool (DB + file) when it has any chunks for this task —
    // it is the canonical streaming-output store. Otherwise fall back to
    // task_output DB rows, which avoids returning a duplicated stream when both
    // stores contain the same data.
    //
    // The diagnostic file (written via appendTaskOutput) is always appended.
    // It is reserved for post-mortem diagnostic blocks (e.g. forced stops or
    // executor startup failures); the streaming runner output goes through the
    // spool. Concatenating it lets retrieval surface concrete failure details
    // that would otherwise be hidden behind a coarse forced-stop reason like
    // "Application quit".
    const diagnosticFile = this.readTaskOutputFile(taskId);
    const spoolChunks = this.getOutputChunks(taskId);
    if (spoolChunks.length > 0) {
      return spoolChunks.map((chunk) => chunk.data).join('') + diagnosticFile;
    }
    const rows = this.queryAll(
      'SELECT data FROM task_output WHERE task_id = ? ORDER BY id ASC',
      [taskId],
    ) as Array<{ data: string }>;
    return rows.map((r) => r.data).join('') + diagnosticFile;
  }

  /**
   * Maintenance: delete task_output rows for tasks that already have output_spool
   * rows. Diagnostic-only task_output rows for tasks with no output_spool rows
   * are preserved. Writes a DB backup before mutating unless `backup: false` is
   * passed. Returns the number of rows deleted and the backup path used (or
   * null for in-memory databases or when `backup: false`).
   */
  pruneDuplicateTaskOutputRows(options?: { backup?: boolean; backupPath?: string }): {
    deletedTaskOutputRows: number;
    backupPath: string | null;
  } {
    this.ensureWritable();

    let backupPath: string | null = null;
    const shouldBackup = options?.backup !== false;
    if (shouldBackup && this.dbPath) {
      backupPath = options?.backupPath ?? `${this.dbPath}.prune-backup-${Date.now()}`;
      if (!existsSync(backupPath)) {
        const dir = dirname(backupPath);
        mkdirSync(dir, { recursive: true });
        this.checkpointWal('FULL');
        this.nativeDb.exec(`VACUUM INTO ${sqlStringLiteral(backupPath)}`);
      }
    }

    const before = this.queryOne('SELECT COUNT(*) AS c FROM task_output') as
      | { c: number }
      | undefined;
    const beforeCount = Number(before?.c ?? 0);

    this.runTransaction(() => {
      this.db.run(`
        DELETE FROM task_output
        WHERE task_id IN (
          SELECT DISTINCT task_id FROM output_spool
        )
      `);
    });

    const after = this.queryOne('SELECT COUNT(*) AS c FROM task_output') as
      | { c: number }
      | undefined;
    const afterCount = Number(after?.c ?? 0);
    return {
      deletedTaskOutputRows: Math.max(0, beforeCount - afterCount),
      backupPath,
    };
  }

  // ── Output Spool ────────────────────────────────────────

  appendOutputChunk(taskId: string, data: string): void {
    this.ensureWritable();
    const nextOffset = this.getNextSpoolOffset(taskId);
    this.ensureOutputSubdir('spool');
    appendFileSync(this.taskSpoolFile(taskId), this.encodeSpoolLine({ offset: nextOffset, data }), 'utf8');
    this.spoolNextOffsetCache.set(taskId, nextOffset + Buffer.byteLength(data, 'utf8'));

    // Update in-memory tail cache
    const tail = this.outputTailCache.get(taskId) ?? [];
    tail.push({ offset: nextOffset, data });

    // Keep only the last N chunks in memory
    if (tail.length > this.outputTailLimit) {
      tail.shift();
    }
    this.outputTailCache.set(taskId, tail);
  }

  getOutputChunks(taskId: string): OutputChunk[] {
    return [...this.getLegacySpoolChunks(taskId), ...this.readSpoolLines(taskId)]
      .sort((a, b) => a.offset - b.offset);
  }

  replayOutputFrom(taskId: string, fromOffset: number): OutputChunk[] {
    const legacyRows = this.queryAll(
      'SELECT offset, data FROM output_spool WHERE task_id = ? AND offset >= ? ORDER BY offset ASC',
      [taskId, fromOffset],
    ) as Array<{ offset: number; data: string }>;

    const legacyChunks = legacyRows.map((row) => ({ offset: row.offset, data: row.data }));
    const fileChunks = this.readSpoolLines(taskId).filter((chunk) => chunk.offset >= fromOffset);
    return [...legacyChunks, ...fileChunks].sort((a, b) => a.offset - b.offset);
  }

  getOutputTail(taskId: string): OutputChunk[] {
    const spoolTail = this.getSpoolOutputTail(taskId);

    const diagnostic = this.readDiagnosticTail(taskId, OUTPUT_DIAGNOSTIC_TAIL_CHARS);
    if (!diagnostic) return spoolTail;
    const lastOffset = spoolTail.length > 0
      ? spoolTail[spoolTail.length - 1].offset + 1
      : 0;
    return [...spoolTail, { offset: lastOffset, data: diagnostic }];
  }

  private readDiagnosticTail(taskId: string, maxChars: number): string {
    const file = this.taskOutputFile(taskId);
    if (!existsSync(file)) return '';
    const size = statSync(file).size;
    if (size === 0) return '';
    if (size <= maxChars) return readFileSync(file, 'utf8');
    const fd = openSync(file, 'r');
    try {
      const buffer = Buffer.allocUnsafe(maxChars);
      readSync(fd, buffer, 0, maxChars, size - maxChars);
      return '...' + buffer.toString('utf8');
    } finally {
      closeSync(fd);
    }
  }

  private getSpoolOutputTail(taskId: string): OutputChunk[] {
    // Return from cache if available
    const cached = this.outputTailCache.get(taskId);
    if (cached && cached.length > 0) {
      return cached;
    }

    const legacyRows = this.queryAll(
      `SELECT offset, data FROM output_spool
       WHERE task_id = ?
       ORDER BY offset DESC
       LIMIT ?`,
      [taskId, this.outputTailLimit],
    ) as Array<{ offset: number; data: string }>;

    const legacyChunks = legacyRows.map((row) => ({ offset: row.offset, data: row.data }));
    const fileChunks = this.readLastSpoolLines(taskId, this.outputTailLimit);
    const chunks = [...legacyChunks, ...fileChunks]
      .sort((a, b) => a.offset - b.offset)
      .slice(-this.outputTailLimit);

    // Populate cache
    if (chunks.length > 0) {
      this.outputTailCache.set(taskId, chunks);
    }

    return chunks;
  }

  // ── Attempts ────────────────────────────────────────────

  saveAttempt(attempt: Attempt): void {
    this.execRun(`
      INSERT OR REPLACE INTO attempts (
        id, node_id, attempt_number, queue_priority, status,
        snapshot_commit, base_branch, upstream_attempt_ids,
        command_override, prompt_override,
        claimed_at, started_at, completed_at, exit_code, error, last_heartbeat_at, lease_expires_at,
        branch, commit_hash, summary, workspace_path, agent_session_id, container_id,
        supersedes_attempt_id, created_at, merge_conflict
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?
      )
    `, [
      attempt.id, attempt.nodeId, 0, attempt.queuePriority, attempt.status,
      attempt.snapshotCommit ?? null, attempt.baseBranch ?? null,
      JSON.stringify(attempt.upstreamAttemptIds),
      attempt.commandOverride ?? null, attempt.promptOverride ?? null,
      attempt.claimedAt?.toISOString() ?? null,
      attempt.startedAt?.toISOString() ?? null,
      attempt.completedAt?.toISOString() ?? null,
      attempt.exitCode ?? null, attempt.error ?? null,
      attempt.lastHeartbeatAt?.toISOString() ?? null,
      attempt.leaseExpiresAt?.toISOString() ?? null,
      attempt.branch ?? null, attempt.commit ?? null, attempt.summary ?? null,
      attempt.workspacePath ?? null, attempt.agentSessionId ?? null,
      attempt.containerId ?? null,
      attempt.supersedesAttemptId ?? null,
      attempt.createdAt.toISOString(),
      attempt.mergeConflict ? JSON.stringify(attempt.mergeConflict) : null,
    ]);
  }

  loadAttempts(nodeId: string): Attempt[] {
    const rows = this.queryAll(
      'SELECT * FROM attempts WHERE node_id = ? ORDER BY created_at ASC',
      [nodeId],
    );
    return rows.map(this.rowToAttempt);
  }

  loadActionGraphAttempts(
    nodeId: string,
    selectedAttemptId?: string,
    recentAttemptLimit = ACTION_GRAPH_RECENT_ATTEMPT_LIMIT,
  ): Attempt[] {
    const limit = Math.max(0, Math.trunc(recentAttemptLimit));
    const rows = this.queryAll(
      `SELECT * FROM attempts
      WHERE node_id = ?
        AND (
          status IN ('pending', 'claimed', 'running', 'needs_input')
          OR id = ?
          OR id IN (
            SELECT id FROM attempts
            WHERE node_id = ?
            ORDER BY created_at DESC
            LIMIT ?
          )
        )
      ORDER BY created_at ASC`,
      [nodeId, selectedAttemptId ?? null, nodeId, limit],
    );
    return rows.map(this.rowToAttempt);
  }

  loadAttempt(attemptId: string): Attempt | undefined {
    const row = this.queryOne(
      'SELECT * FROM attempts WHERE id = ?',
      [attemptId],
    );
    if (!row) return undefined;
    return this.rowToAttempt(row);
  }

  updateAttempt(attemptId: string, changes: Partial<Pick<Attempt, 'status' | 'claimedAt' | 'startedAt' | 'completedAt' | 'exitCode' | 'error' | 'lastHeartbeatAt' | 'leaseExpiresAt' | 'branch' | 'commit' | 'summary' | 'queuePriority' | 'workspacePath' | 'agentSessionId' | 'containerId' | 'mergeConflict'>>): void {
    const setClauses: string[] = [];
    const values: any[] = [];

    if (changes.status !== undefined) { setClauses.push('status = ?'); values.push(changes.status); }
    if (changes.claimedAt !== undefined) { setClauses.push('claimed_at = ?'); values.push(changes.claimedAt instanceof Date ? changes.claimedAt.toISOString() : changes.claimedAt ?? null); }
    if (changes.startedAt !== undefined) { setClauses.push('started_at = ?'); values.push(changes.startedAt instanceof Date ? changes.startedAt.toISOString() : changes.startedAt ?? null); }
    if (changes.completedAt !== undefined) { setClauses.push('completed_at = ?'); values.push(changes.completedAt instanceof Date ? changes.completedAt.toISOString() : changes.completedAt ?? null); }
    if (changes.exitCode !== undefined) { setClauses.push('exit_code = ?'); values.push(changes.exitCode); }
    if (changes.error !== undefined) { setClauses.push('error = ?'); values.push(changes.error); }
    if (changes.lastHeartbeatAt !== undefined) { setClauses.push('last_heartbeat_at = ?'); values.push(changes.lastHeartbeatAt instanceof Date ? changes.lastHeartbeatAt.toISOString() : changes.lastHeartbeatAt ?? null); }
    if (changes.leaseExpiresAt !== undefined) { setClauses.push('lease_expires_at = ?'); values.push(changes.leaseExpiresAt instanceof Date ? changes.leaseExpiresAt.toISOString() : changes.leaseExpiresAt ?? null); }
    if (changes.branch !== undefined) { setClauses.push('branch = ?'); values.push(changes.branch); }
    if (changes.commit !== undefined) { setClauses.push('commit_hash = ?'); values.push(changes.commit); }
    if (changes.summary !== undefined) { setClauses.push('summary = ?'); values.push(changes.summary); }
    if (changes.queuePriority !== undefined) { setClauses.push('queue_priority = ?'); values.push(changes.queuePriority); }
    if (changes.workspacePath !== undefined) { setClauses.push('workspace_path = ?'); values.push(changes.workspacePath); }
    if (changes.agentSessionId !== undefined) { setClauses.push('agent_session_id = ?'); values.push(changes.agentSessionId); }
    if (changes.containerId !== undefined) { setClauses.push('container_id = ?'); values.push(changes.containerId); }
    if (changes.mergeConflict !== undefined) { setClauses.push('merge_conflict = ?'); values.push(changes.mergeConflict ? JSON.stringify(changes.mergeConflict) : null); }

    if (setClauses.length === 0) return;
    values.push(attemptId);
    this.execRun(`UPDATE attempts SET ${setClauses.join(', ')} WHERE id = ?`, values);
  }

  claimAttemptForLaunch(
    attemptId: string,
    changes: Partial<Pick<Attempt, 'status' | 'claimedAt' | 'startedAt' | 'lastHeartbeatAt' | 'leaseExpiresAt' | 'queuePriority'>>,
    now: Date,
  ): boolean {
    const setClauses: string[] = [];
    const values: any[] = [];

    if (changes.status !== undefined) { setClauses.push('status = ?'); values.push(changes.status); }
    if (changes.claimedAt !== undefined) { setClauses.push('claimed_at = ?'); values.push(changes.claimedAt instanceof Date ? changes.claimedAt.toISOString() : changes.claimedAt ?? null); }
    if (changes.startedAt !== undefined) { setClauses.push('started_at = ?'); values.push(changes.startedAt instanceof Date ? changes.startedAt.toISOString() : changes.startedAt ?? null); }
    if (changes.lastHeartbeatAt !== undefined) { setClauses.push('last_heartbeat_at = ?'); values.push(changes.lastHeartbeatAt instanceof Date ? changes.lastHeartbeatAt.toISOString() : changes.lastHeartbeatAt ?? null); }
    if (changes.leaseExpiresAt !== undefined) { setClauses.push('lease_expires_at = ?'); values.push(changes.leaseExpiresAt instanceof Date ? changes.leaseExpiresAt.toISOString() : changes.leaseExpiresAt ?? null); }
    if (changes.queuePriority !== undefined) { setClauses.push('queue_priority = ?'); values.push(changes.queuePriority); }

    if (setClauses.length === 0) return false;
    values.push(attemptId, now.toISOString());
    this.ensureWritable();
    this.db.run(
      `UPDATE attempts SET ${setClauses.join(', ')}
       WHERE id = ?
         AND (
           status = 'pending'
           OR (
             status IN ('claimed', 'running')
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at <= ?
           )
         )`,
      values,
    );
    const claimed = this.db.getRowsModified() > 0;
    if (claimed) {
      this.dirty = true;
    }
    return claimed;
  }

  failTaskAndAttempt(
    taskId: string,
    taskChanges: TaskStateChanges,
    attemptPatch: Partial<Pick<Attempt, 'status' | 'exitCode' | 'error' | 'completedAt'>>
  ): void {
    this.runTransaction(() => {
      // Update task state
      this.updateTask(taskId, taskChanges);

      // Load the latest attempt for this task
      const row = this.queryOne(
        'SELECT id, status FROM attempts WHERE node_id = ? ORDER BY created_at DESC LIMIT 1',
        [taskId],
      ) as { id: string; status: string } | undefined;

      // If there's an active attempt, update it with the failure details.
      // Claimed is included because launch-time failures can happen before
      // the attempt reaches persisted running state.
      if (row && (row.status === 'running' || row.status === 'claimed')) {
        this.updateAttempt(row.id, attemptPatch);
      }
    });
  }

  // ── Activity Log ─────────────────────────────────────

  writeActivityLog(source: string, level: string, message: string): void {
    this.execRun(
      'INSERT INTO activity_log (source, level, message) VALUES (?, ?, ?)',
      [source, level, message],
    );
    this.activityLogWritesSincePrune += 1;
    if (this.activityLogWritesSincePrune >= ACTIVITY_LOG_PRUNE_INTERVAL) {
      this.activityLogWritesSincePrune = 0;
      try {
        this.pruneActivityLog();
      } catch {
        /* best-effort: a prune failure must not break logging */
      }
    }
  }

  /** Bound activity_log to its newest `maxRows` rows; returns rows deleted. No-op when read-only or maxRows <= 0. */
  pruneActivityLog(maxRows: number = this.activityLogMaxRows): number {
    if (this.readOnly || !Number.isFinite(maxRows) || maxRows <= 0) return 0;
    const total = this.queryOne('SELECT COUNT(*) AS c FROM activity_log') as
      | { c: number }
      | undefined;
    const count = total?.c ?? 0;
    if (count <= maxRows) return 0;
    // keep newest maxRows; ids are monotonic so OFFSET is gap-safe
    const boundary = this.queryOne(
      'SELECT id FROM activity_log ORDER BY id DESC LIMIT 1 OFFSET ?',
      [maxRows],
    ) as { id: number } | undefined;
    if (!boundary) return 0;
    this.execRun('DELETE FROM activity_log WHERE id <= ?', [boundary.id]);
    return count - maxRows;
  }

  getActivityLogs(sinceId = 0, limit = 200): ActivityLogEntry[] {
    const rows = this.queryAll(
      'SELECT * FROM activity_log WHERE id > ? ORDER BY id ASC LIMIT ?',
      [sinceId, limit],
    );
    return rows.map((row: any) => ({
      id: row.id,
      timestamp: row.timestamp,
      source: row.source,
      level: row.level,
      message: row.message,
    }));
  }

  // ── Lifecycle ─────────────────────────────────────────

  close(): void {
    if (this.dbPath && !this.readOnly) {
      this.checkpointWal('PASSIVE');
    }
    this.db.close();
  }

  // ── Helpers ───────────────────────────────────────────

  private loadWorkflowRollups(workflowIds: string[]): Map<string, WorkflowRollup> {
    const rollups = new Map<string, WorkflowRollup>();
    if (workflowIds.length === 0) return rollups;

    const placeholders = workflowIds.map(() => '?').join(', ');
    const taskRows = this.queryAll(
      `SELECT id, workflow_id, description, status, dependencies, error, protocol_error_code, protocol_error_message,
              pending_fix_error, exit_code, completed_at, agent_session_id, agent_name,
              review_url, input_prompt, is_fixing_with_ai
       FROM tasks
       WHERE workflow_id IN (${placeholders})
       ORDER BY id ASC`,
      workflowIds,
    );

    return this.computeWorkflowRollupsFromRows(workflowIds, taskRows);
  }

  private computeWorkflowRollupsFromRows(
    workflowIds: string[],
    taskRows: Record<string, unknown>[],
  ): Map<string, WorkflowRollup> {
    const rollups = new Map<string, WorkflowRollup>();
    const tasksByWorkflow = new Map<string, WorkflowRollupTaskSummary[]>();
    for (const row of taskRows as any[]) {
      const workflowId = String(row.workflow_id);
      const tasks = tasksByWorkflow.get(workflowId) ?? [];
      tasks.push({
        id: String(row.id),
        description: String(row.description),
        status: row.status as TaskStatus,
        dependencies: JSON.parse(row.dependencies || '[]'),
        execution: {
          error: row.error ?? undefined,
          protocolErrorCode: row.protocol_error_code ?? undefined,
          protocolErrorMessage: row.protocol_error_message ?? undefined,
          pendingFixError: row.pending_fix_error ?? undefined,
          exitCode: row.exit_code ?? undefined,
          completedAt: row.completed_at ?? undefined,
          agentSessionId: row.agent_session_id ?? undefined,
          agentName: row.agent_name ?? undefined,
          reviewUrl: row.review_url ?? undefined,
          inputPrompt: row.input_prompt ?? undefined,
          isFixingWithAI: row.is_fixing_with_ai === 1,
        },
      });
      tasksByWorkflow.set(workflowId, tasks);
    }

    for (const workflowId of workflowIds) {
      const tasks = tasksByWorkflow.get(workflowId) ?? [];
      rollups.set(workflowId, computeWorkflowRollupFromSummaries(tasks));
    }

    return rollups;
  }

  private rowToWorkflow(row: any, rollup?: WorkflowRollup): Workflow {
    return mapRowToWorkflow(row, rollup);
  }

  private rowToTask(row: any): TaskState {
    return mapRowToTask(row);
  }

  private reconcileTaskFromSelectedAttempt(task: TaskState): TaskState {
    const attemptId = task.execution.selectedAttemptId;
    if (!attemptId) return task;

    const taskIsTerminal =
      task.status === 'completed' ||
      task.status === 'failed' ||
      task.status === 'fixing_with_ai' ||
      task.status === 'needs_input' ||
      task.status === 'awaiting_approval' ||
      task.status === 'review_ready' ||
      task.status === 'stale';
    if (taskIsTerminal) return task;

    const attempt = this.loadAttempt(attemptId);
    if (!attempt) return task;

    if (isDiscardedAttempt(attempt)) {
      return {
        ...task,
        status: 'stale',
      };
    }

    if (attempt.status === 'failed') {
      return {
        ...task,
        status: 'failed',
        execution: {
          ...task.execution,
          exitCode: attempt.exitCode ?? task.execution.exitCode,
          error: attempt.error ?? task.execution.error,
          completedAt: attempt.completedAt ?? task.execution.completedAt,
          lastHeartbeatAt: attempt.lastHeartbeatAt ?? task.execution.lastHeartbeatAt,
          branch: attempt.branch ?? task.execution.branch,
          commit: attempt.commit ?? task.execution.commit,
          workspacePath: attempt.workspacePath ?? task.execution.workspacePath,
          agentSessionId: attempt.agentSessionId ?? task.execution.agentSessionId,
          containerId: attempt.containerId ?? task.execution.containerId,
        },
      };
    }

    if (attempt.status === 'completed') {
      return {
        ...task,
        status: 'completed',
        config: {
          ...task.config,
          summary: attempt.summary ?? task.config.summary,
        },
        execution: {
          ...task.execution,
          exitCode: attempt.exitCode ?? task.execution.exitCode,
          completedAt: attempt.completedAt ?? task.execution.completedAt,
          lastHeartbeatAt: attempt.lastHeartbeatAt ?? task.execution.lastHeartbeatAt,
          branch: attempt.branch ?? task.execution.branch,
          commit: attempt.commit ?? task.execution.commit,
          workspacePath: attempt.workspacePath ?? task.execution.workspacePath,
          agentSessionId: attempt.agentSessionId ?? task.execution.agentSessionId,
          containerId: attempt.containerId ?? task.execution.containerId,
        },
      };
    }

    if (attempt.status === 'needs_input') {
      return {
        ...task,
        status: 'needs_input',
      };
    }

    return task;
  }

  private rowToAttempt(row: any): Attempt {
    return mapRowToAttempt(row);
  }

  enqueueWorkflowMutationIntent(
    workflowId: string,
    channel: string,
    args: unknown[],
    priority: WorkflowMutationPriority,
  ): number {
    this.execRun(
      `INSERT INTO workflow_mutation_intents (
        workflow_id, channel, args_json, priority, status
      ) VALUES (?, ?, ?, ?, 'queued')`,
      [workflowId, channel, JSON.stringify(args), priority],
    );
    const row = this.queryOne('SELECT MAX(id) AS id FROM workflow_mutation_intents');
    return Number(row?.id ?? 0);
  }

  evictQueuedWorkflowMutationIntentsBefore(
    workflowId: string,
    beforeIntentId: number,
    reason: string = 'Evicted by workflow reset boundary',
  ): number[] {
    const cutoff = Math.floor(beforeIntentId);
    if (!Number.isFinite(cutoff) || cutoff <= 0) {
      return [];
    }
    const rows = this.queryAll(
      `SELECT id
         FROM workflow_mutation_intents
        WHERE workflow_id = ?
          AND status = 'queued'
          AND id < ?`,
      [workflowId, cutoff],
    );
    const evictedIds = rows
      .map((row) => Number(row.id))
      .filter((id) => Number.isFinite(id));
    if (evictedIds.length === 0) {
      return [];
    }
    this.execRun(
      `UPDATE workflow_mutation_intents
          SET status = 'failed',
              completed_at = ?,
              error = ?
        WHERE workflow_id = ?
          AND status = 'queued'
          AND id < ?`,
      [new Date().toISOString(), reason, workflowId, cutoff],
    );
    return evictedIds;
  }

  loadWorkflowMutationIntent(id: number): WorkflowMutationIntent | undefined {
    const row = this.queryOne('SELECT * FROM workflow_mutation_intents WHERE id = ?', [id]);
    return row ? this.rowToWorkflowMutationIntent(row) : undefined;
  }

  listWorkflowMutationIntents(
    workflowId?: string,
    statuses?: WorkflowMutationIntentStatus[],
  ): WorkflowMutationIntent[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (workflowId) {
      where.push('workflow_id = ?');
      params.push(workflowId);
    }
    if (statuses && statuses.length > 0) {
      where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    const rows = this.queryAll(
      `SELECT * FROM workflow_mutation_intents ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ` +
        `ORDER BY CASE priority WHEN 'high' THEN 0 ELSE 1 END ASC, id ASC`,
      params,
    );
    return rows.map((row) => this.rowToWorkflowMutationIntent(row));
  }

  requeueRunningWorkflowMutationIntents(): number {
    const running = this.queryOne(
      `SELECT COUNT(*) AS count FROM workflow_mutation_intents WHERE status = 'running'`,
    );
    this.execRun(
      `UPDATE workflow_mutation_intents
         SET status = 'queued', owner_id = NULL, started_at = NULL, completed_at = NULL
       WHERE status = 'running'`,
    );
    return Number(running?.count ?? 0);
  }

  requeueOrphanedWorkflowMutationIntents(now: Date = new Date()): number {
    const rows = this.queryAll(
      `SELECT i.id
         FROM workflow_mutation_intents i
         LEFT JOIN workflow_mutation_leases l
           ON l.workflow_id = i.workflow_id
          AND l.active_intent_id = i.id
          AND l.lease_expires_at >= ?
        WHERE i.status = 'running'
          AND l.workflow_id IS NULL`,
      [now.toISOString()],
    );
    const ids = rows
      .map((row) => Number(row.id))
      .filter((id) => Number.isFinite(id));
    if (ids.length === 0) {
      return 0;
    }
    this.execRun(
      `UPDATE workflow_mutation_intents
         SET status = 'queued', owner_id = NULL, started_at = NULL, completed_at = NULL, error = NULL
       WHERE status = 'running'
         AND id IN (${ids.map(() => '?').join(', ')})`,
      ids,
    );
    return ids.length;
  }

  claimNextWorkflowMutationIntent(
    workflowId: string,
    ownerId: string,
  ): WorkflowMutationIntent | undefined {
    const next = this.queryOne(
      `SELECT * FROM workflow_mutation_intents
       WHERE workflow_id = ? AND status = 'queued'
       ORDER BY CASE priority WHEN 'high' THEN 0 ELSE 1 END ASC, id ASC
       LIMIT 1`,
      [workflowId],
    );
    if (!next) return undefined;
    this.execRun(
      `UPDATE workflow_mutation_intents
         SET status = 'running', owner_id = ?, started_at = ?, completed_at = NULL, error = NULL
       WHERE id = ? AND status = 'queued'`,
      [ownerId, new Date().toISOString(), next.id],
    );
    const claimed = this.queryOne('SELECT * FROM workflow_mutation_intents WHERE id = ?', [next.id]);
    if (!claimed || claimed.status !== 'running') return undefined;
    return this.rowToWorkflowMutationIntent(claimed);
  }

  claimWorkflowMutationLease(
    workflowId: string,
    ownerId: string,
    options?: { activeIntentId?: number; activeMutationKind?: string },
  ): boolean {
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + WORKFLOW_MUTATION_LEASE_MS).toISOString();
    const existing = this.queryOne(
      'SELECT * FROM workflow_mutation_leases WHERE workflow_id = ?',
      [workflowId],
    );

    if (!existing) {
      this.execRun(
        `INSERT INTO workflow_mutation_leases (
          workflow_id, owner_id, active_intent_id, active_mutation_kind, leased_at, last_heartbeat_at, lease_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          workflowId,
          ownerId,
          options?.activeIntentId ?? null,
          options?.activeMutationKind ?? null,
          now,
          now,
          leaseExpiresAt,
        ],
      );
      return true;
    }

    const existingOwnerId = String(existing.owner_id);
    const existingExpiry = existing.lease_expires_at ? new Date(String(existing.lease_expires_at)).getTime() : 0;
    const isExpired = existingExpiry < Date.now();

    if (existingOwnerId !== ownerId && !isExpired) {
      return false;
    }

    if (isExpired) {
      this.requeueWorkflowMutationLease(workflowId);
    }

    this.execRun(
      `INSERT OR REPLACE INTO workflow_mutation_leases (
        workflow_id, owner_id, active_intent_id, active_mutation_kind, leased_at, last_heartbeat_at, lease_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        workflowId,
        ownerId,
        options?.activeIntentId ?? null,
        options?.activeMutationKind ?? null,
        now,
        now,
        leaseExpiresAt,
      ],
    );
    return true;
  }

  renewWorkflowMutationLease(
    workflowId: string,
    ownerId: string,
    options?: {
      activeIntentId?: number;
      activeMutationKind?: string;
      minHeartbeatIntervalMs?: number;
      minExpiryLeadMs?: number;
    },
  ): boolean {
    const lease = this.queryOne(
      'SELECT * FROM workflow_mutation_leases WHERE workflow_id = ?',
      [workflowId],
    );
    if (!lease || String(lease.owner_id) !== ownerId) {
      return false;
    }

    const nowMs = Date.now();
    const nextIntentId = options?.activeIntentId ?? null;
    const nextMutationKind = options?.activeMutationKind ?? null;
    const sameIntent = String(lease.active_intent_id ?? '') === String(nextIntentId ?? '');
    const sameKind = String(lease.active_mutation_kind ?? '') === String(nextMutationKind ?? '');
    const lastHeartbeatMs = lease.last_heartbeat_at ? Date.parse(String(lease.last_heartbeat_at)) : 0;
    const leaseExpiryMs = lease.lease_expires_at ? Date.parse(String(lease.lease_expires_at)) : 0;
    const minHeartbeatIntervalMs = options?.minHeartbeatIntervalMs ?? 0;
    const minExpiryLeadMs = options?.minExpiryLeadMs ?? 0;

    if (
      sameIntent &&
      sameKind &&
      minHeartbeatIntervalMs > 0 &&
      Number.isFinite(lastHeartbeatMs) &&
      lastHeartbeatMs > 0 &&
      nowMs - lastHeartbeatMs < minHeartbeatIntervalMs &&
      Number.isFinite(leaseExpiryMs) &&
      leaseExpiryMs - nowMs > minExpiryLeadMs
    ) {
      return true;
    }

    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(nowMs + WORKFLOW_MUTATION_LEASE_MS).toISOString();
    this.execRun(
      `UPDATE workflow_mutation_leases
         SET active_intent_id = ?,
             active_mutation_kind = ?,
             last_heartbeat_at = ?,
             lease_expires_at = ?
       WHERE workflow_id = ? AND owner_id = ?`,
      [
        options?.activeIntentId ?? null,
        options?.activeMutationKind ?? null,
        now,
        leaseExpiresAt,
        workflowId,
        ownerId,
      ],
    );
    return true;
  }

  releaseWorkflowMutationLease(workflowId: string, ownerId: string): void {
    this.execRun(
      'DELETE FROM workflow_mutation_leases WHERE workflow_id = ? AND owner_id = ?',
      [workflowId, ownerId],
    );
  }

  claimExecutionResourceLease(options: {
    resourceKey: string;
    resourceType: string;
    holderId: string;
    taskId?: string;
    poolId?: string;
    poolMemberId?: string;
    metadata?: unknown;
    leaseMs?: number;
  }): boolean {
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + (options.leaseMs ?? EXECUTION_RESOURCE_LEASE_MS)).toISOString();
    return this.runTransaction(() => {
      this.execRun(
        'DELETE FROM execution_resource_leases WHERE resource_key = ? AND lease_expires_at <= ?',
        [options.resourceKey, nowIso],
      );
      const active = this.queryOne(
        `SELECT holder_id FROM execution_resource_leases
         WHERE resource_key = ?
           AND holder_id != ?
           AND lease_expires_at > ?
         LIMIT 1`,
        [options.resourceKey, options.holderId, nowIso],
      );
      if (active) return false;

      this.execRun(
        `INSERT OR REPLACE INTO execution_resource_leases (
          resource_key, resource_type, holder_id, task_id, pool_id, pool_member_id,
          acquired_at, last_heartbeat_at, lease_expires_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          options.resourceKey,
          options.resourceType,
          options.holderId,
          options.taskId ?? null,
          options.poolId ?? null,
          options.poolMemberId ?? null,
          nowIso,
          nowIso,
          leaseExpiresAt,
          options.metadata === undefined ? null : JSON.stringify(options.metadata),
        ],
      );
      return true;
    });
  }

  renewExecutionResourceLease(
    resourceKey: string,
    holderId: string,
    leaseMs = EXECUTION_RESOURCE_LEASE_MS,
  ): boolean {
    const now = new Date();
    this.execRun(
      `UPDATE execution_resource_leases
         SET last_heartbeat_at = ?,
             lease_expires_at = ?
       WHERE resource_key = ?
         AND holder_id = ?`,
      [
        now.toISOString(),
        new Date(now.getTime() + leaseMs).toISOString(),
        resourceKey,
        holderId,
      ],
    );
    const changed = (this.db.getRowsModified?.() ?? 0) as number;
    return changed > 0;
  }

  releaseExecutionResourceLease(resourceKey: string, holderId: string): void {
    this.execRun(
      'DELETE FROM execution_resource_leases WHERE resource_key = ? AND holder_id = ?',
      [resourceKey, holderId],
    );
  }

  listExecutionResourceLeases(): ExecutionResourceLease[] {
    return this.queryAll(
      'SELECT * FROM execution_resource_leases ORDER BY resource_key ASC, acquired_at ASC',
    ).map((row) => ({
      resourceKey: String(row.resource_key),
      resourceType: String(row.resource_type),
      holderId: String(row.holder_id),
      taskId: row.task_id ? String(row.task_id) : undefined,
      poolId: row.pool_id ? String(row.pool_id) : undefined,
      poolMemberId: row.pool_member_id ? String(row.pool_member_id) : undefined,
      acquiredAt: String(row.acquired_at),
      lastHeartbeatAt: String(row.last_heartbeat_at),
      leaseExpiresAt: String(row.lease_expires_at),
      metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : undefined,
    }));
  }

  /**
   * Return every execution-resource lease held on behalf of a specific
   * task. Used by the LaunchDispatcher when abandoning a stuck launch
   * to release any SSH-pool / worktree-pool leases the task acquired
   * during executor selection but never released (Issue 14).
   */
  listExecutionResourceLeasesByTask(taskId: string): ExecutionResourceLease[] {
    return this.queryAll(
      'SELECT * FROM execution_resource_leases WHERE task_id = ? ORDER BY acquired_at ASC',
      [taskId],
    ).map((row) => ({
      resourceKey: String(row.resource_key),
      resourceType: String(row.resource_type),
      holderId: String(row.holder_id),
      taskId: row.task_id ? String(row.task_id) : undefined,
      poolId: row.pool_id ? String(row.pool_id) : undefined,
      poolMemberId: row.pool_member_id ? String(row.pool_member_id) : undefined,
      acquiredAt: String(row.acquired_at),
      lastHeartbeatAt: String(row.last_heartbeat_at),
      leaseExpiresAt: String(row.lease_expires_at),
      metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : undefined,
    }));
  }

  releaseExecutionResourceLeasesForTasks(
    taskIds: readonly string[],
    _reason: string,
    _nowIso?: string,
  ): ExecutionResourceLeaseReleaseRow[] {
    const ids = Array.from(new Set(taskIds.filter((id): id is string => typeof id === 'string' && id.length > 0)));
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');

    return this.runTransaction(() => {
      const rows = this.queryAll(
        `SELECT resource_key, resource_type, holder_id, task_id
           FROM execution_resource_leases
          WHERE task_id IN (${placeholders})
          ORDER BY acquired_at ASC, resource_key ASC`,
        ids,
      );
      if (rows.length === 0) return [];

      this.execRun(
        `DELETE FROM execution_resource_leases
          WHERE task_id IN (${placeholders})`,
        ids,
      );

      return rows.map((row) => ({
        resourceKey: String(row.resource_key),
        resourceType: String(row.resource_type),
        holderId: String(row.holder_id),
        taskId: row.task_id ? String(row.task_id) : undefined,
      }));
    });
  }

  enqueueLaunchDispatch(input: {
    taskId: string;
    attemptId: string;
    workflowId: string;
    priority?: TaskLaunchDispatchPriority;
    generation: number;
  }): TaskLaunchDispatch {
    const priority: TaskLaunchDispatchPriority = input.priority ?? 'normal';
    return this.runTransaction(() => {
      const existing = this.queryOne(
        `SELECT * FROM task_launch_dispatch
           WHERE attempt_id = ?
             AND state IN ('enqueued', 'leased')
           LIMIT 1`,
        [input.attemptId],
      );
      if (existing) {
        return this.rowToTaskLaunchDispatch(existing);
      }
      this.execRun(
        `INSERT INTO task_launch_dispatch (
          task_id, attempt_id, workflow_id, state, priority, generation
        ) VALUES (?, ?, ?, 'enqueued', ?, ?)`,
        [input.taskId, input.attemptId, input.workflowId, priority, input.generation],
      );
      const inserted = this.queryOne(
        `SELECT * FROM task_launch_dispatch
           WHERE attempt_id = ?
             AND state IN ('enqueued', 'leased')
           LIMIT 1`,
        [input.attemptId],
      );
      if (!inserted) {
        throw new Error('Failed to read back inserted task_launch_dispatch row');
      }
      const dispatch = this.rowToTaskLaunchDispatch(inserted);
      this.logEvent(input.taskId, 'task.launch_dispatch_enqueued', {
        dispatchId: dispatch.id,
        attemptId: input.attemptId,
        workflowId: input.workflowId,
        generation: input.generation,
        priority,
      });
      return dispatch;
    });
  }

  loadLaunchDispatchById(id: number): TaskLaunchDispatch | undefined {
    const row = this.queryOne(
      'SELECT * FROM task_launch_dispatch WHERE id = ?',
      [id],
    );
    return row ? this.rowToTaskLaunchDispatch(row) : undefined;
  }

  loadLaunchDispatchByAttempt(attemptId: string): TaskLaunchDispatch | undefined {
    const row = this.queryOne(
      `SELECT * FROM task_launch_dispatch
         WHERE attempt_id = ?
           AND state IN ('enqueued', 'leased')
         ORDER BY id DESC
         LIMIT 1`,
      [attemptId],
    );
    return row ? this.rowToTaskLaunchDispatch(row) : undefined;
  }

  listLaunchDispatchesByState(
    states: readonly TaskLaunchDispatchState[],
  ): TaskLaunchDispatch[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => '?').join(', ');
    const rows = this.queryAll(
      `SELECT * FROM task_launch_dispatch
         WHERE state IN (${placeholders})
         ORDER BY id ASC`,
      states as unknown as unknown[],
    );
    return rows.map((row) => this.rowToTaskLaunchDispatch(row));
  }

  /**
   * Atomic lease of the next enqueued dispatch row.
   *
   * Selects the oldest enqueued row (priority high < normal < low, then id
   * ascending) and transitions it to `leased`. Wrapped in an IMMEDIATE
   * transaction so concurrent dispatchers cannot double-lease. Returns the
   * freshly leased row or `undefined` when nothing is enqueued or another
   * dispatcher beat us to it.
   */
  claimLaunchDispatchAtomic(options: {
    ownerId: string;
    nowIso?: string;
  }): TaskLaunchDispatch | undefined {
    const now = options.nowIso ?? new Date().toISOString();
    const fencedUntil = new Date(
      new Date(now).getTime() + DISPATCH_LEASE_MS,
    ).toISOString();
    return this.runTransaction(() => {
      while (true) {
        const candidate = this.queryOne(
          `SELECT
             d.*,
             t.id AS current_task_id,
             t.status AS current_task_status,
             t.selected_attempt_id AS current_selected_attempt_id,
             t.execution_generation AS current_execution_generation
           FROM task_launch_dispatch d
           LEFT JOIN tasks t ON t.id = d.task_id
           WHERE d.state = 'enqueued'
           ORDER BY CASE d.priority
             WHEN 'high' THEN 0
             WHEN 'normal' THEN 1
             ELSE 2
           END, d.id
           LIMIT 1`,
        );
        if (!candidate || candidate.id == null) return undefined;
        const candidateId = Number(candidate.id);

        let staleReason: string | undefined;
        if (!candidate.current_task_id) {
          staleReason = `Launch dispatch ${candidateId} is stale: task ${String(candidate.task_id)} no longer exists`;
        } else if (String(candidate.current_task_status) !== 'pending') {
          staleReason =
            `Launch dispatch ${candidateId} is stale: task ${String(candidate.task_id)} ` +
            `status is ${String(candidate.current_task_status)}`;
        } else if (String(candidate.current_selected_attempt_id ?? '') !== String(candidate.attempt_id)) {
          staleReason =
            `Launch dispatch ${candidateId} is stale: attempt ${String(candidate.attempt_id)} ` +
            `is not the selected attempt ${String(candidate.current_selected_attempt_id ?? 'none')}`;
        } else if (Number(candidate.current_execution_generation ?? 0) !== Number(candidate.generation ?? 0)) {
          staleReason =
            `Launch dispatch ${candidateId} is stale: generation ${String(candidate.generation)} ` +
            `does not match task generation ${String(candidate.current_execution_generation ?? 0)}`;
        }

        if (staleReason) {
          this.execRun(
            `UPDATE task_launch_dispatch
               SET state = 'abandoned',
                   completed_at = ?,
                   last_error = ?,
                   dispatch_owner = NULL,
                   fenced_until = NULL
             WHERE id = ?
               AND state = 'enqueued'`,
            [now, staleReason, candidateId],
          );
          continue;
        }

        this.execRun(
          `UPDATE task_launch_dispatch
             SET state = 'leased',
                 dispatch_owner = ?,
                 leased_at = ?,
                 fenced_until = ?,
                 attempts_count = attempts_count + 1
           WHERE id = ?
             AND state = 'enqueued'`,
          [options.ownerId, now, fencedUntil, candidateId],
        );
        const updated = (this.db.getRowsModified?.() ?? 0) > 0;
        if (!updated) return undefined;
        const row = this.queryOne(
          'SELECT * FROM task_launch_dispatch WHERE id = ?',
          [candidateId],
        );
        if (!row) return undefined;
        const dispatch = this.rowToTaskLaunchDispatch(row);
        this.logEvent(dispatch.taskId, 'task.launch_dispatch_claimed', {
          dispatchId: dispatch.id,
          ownerId: options.ownerId,
          attemptId: dispatch.attemptId,
          workflowId: dispatch.workflowId,
          generation: dispatch.generation,
          fencedUntil: dispatch.fencedUntil,
        });
        return dispatch;
      }
    });
  }

  markLaunchDispatchCompleted(id: number, nowIso?: string): boolean {
    const now = nowIso ?? new Date().toISOString();
    this.execRun(
      `UPDATE task_launch_dispatch
         SET state = 'completed',
             completed_at = ?
       WHERE id = ?
         AND state NOT IN ('completed', 'abandoned')`,
      [now, id],
    );
    return (this.db.getRowsModified?.() ?? 0) > 0;
  }

  markLaunchDispatchFailed(
    id: number,
    errorMessage: string,
    _nowIso?: string,
  ): boolean {
    this.execRun(
      `UPDATE task_launch_dispatch
         SET state = 'enqueued',
             last_error = ?,
             dispatch_owner = NULL,
             fenced_until = NULL
       WHERE id = ?
         AND state NOT IN ('completed', 'abandoned')`,
      [errorMessage, id],
    );
    return (this.db.getRowsModified?.() ?? 0) > 0;
  }

  listAbandonableLaunchDispatchLeases(options: {
    nowIso?: string;
    maxAttempts: number;
  }): TaskLaunchDispatch[] {
    const now = options.nowIso ?? new Date().toISOString();
    const rows = this.queryAll(
      `SELECT * FROM task_launch_dispatch
         WHERE state = 'leased'
           AND fenced_until IS NOT NULL
           AND fenced_until < ?
           AND attempts_count >= ?
         ORDER BY id ASC`,
      [now, options.maxAttempts],
    );
    return rows.map((row) => this.rowToTaskLaunchDispatch(row));
  }

  /**
   * Terminal abandon: row leaves the live set. Returns false when the row
   * is already terminal so callers can treat a race as a no-op.
   */
  markLaunchDispatchAbandoned(
    id: number,
    errorMessage: string,
    nowIso?: string,
  ): boolean {
    const now = nowIso ?? new Date().toISOString();
    this.execRun(
      `UPDATE task_launch_dispatch
         SET state = 'abandoned',
             completed_at = ?,
             last_error = ?,
             dispatch_owner = NULL,
             fenced_until = NULL
       WHERE id = ?
         AND state NOT IN ('completed', 'abandoned')`,
      [now, errorMessage, id],
    );
    return (this.db.getRowsModified?.() ?? 0) > 0;
  }

  abandonLaunchDispatchesForTasks(
    taskIds: readonly string[],
    reason: string,
    nowIso?: string,
  ): LaunchDispatchInvalidationRow[] {
    const ids = Array.from(new Set(taskIds.filter((id): id is string => typeof id === 'string' && id.length > 0)));
    if (ids.length === 0) return [];
    const now = nowIso ?? new Date().toISOString();
    const taskPlaceholders = ids.map(() => '?').join(', ');

    return this.runTransaction(() => {
      const rows = this.queryAll(
        `SELECT id, task_id, attempt_id, workflow_id, state, generation
           FROM task_launch_dispatch
          WHERE task_id IN (${taskPlaceholders})
            AND state IN ('enqueued', 'leased')
          ORDER BY id ASC`,
        ids,
      );
      if (rows.length === 0) return [];

      const rowIds = rows.map((row) => Number(row.id));
      const idPlaceholders = rowIds.map(() => '?').join(', ');
      this.execRun(
        `UPDATE task_launch_dispatch
            SET state = 'abandoned',
                completed_at = ?,
                last_error = ?,
                dispatch_owner = NULL,
                fenced_until = NULL
          WHERE id IN (${idPlaceholders})
            AND state IN ('enqueued', 'leased')`,
        [now, reason, ...rowIds],
      );

      return rows.map((row) => ({
        id: Number(row.id),
        taskId: String(row.task_id),
        attemptId: String(row.attempt_id),
        workflowId: String(row.workflow_id),
        state: String(row.state),
        generation: Number(row.generation ?? 0),
      }));
    });
  }

  reapExpiredLaunchDispatchLeases(options: {
    nowIso?: string;
    maxAttempts?: number;
  } = {}): TaskLaunchDispatch[] {
    const now = options.nowIso ?? new Date().toISOString();
    const maxAttempts = options.maxAttempts ?? Number.MAX_SAFE_INTEGER;
    return this.runTransaction(() => {
      const expired = this.queryAll(
        `SELECT * FROM task_launch_dispatch
           WHERE state = 'leased'
             AND fenced_until IS NOT NULL
             AND fenced_until < ?
             AND attempts_count < ?`,
        [now, maxAttempts],
      );
      if (expired.length === 0) return [];
      this.execRun(
        `UPDATE task_launch_dispatch
           SET state = 'enqueued',
               dispatch_owner = NULL,
               fenced_until = NULL
         WHERE state = 'leased'
           AND fenced_until IS NOT NULL
           AND fenced_until < ?
           AND attempts_count < ?`,
        [now, maxAttempts],
      );
      return expired.map((row) => {
        const reset = { ...row, state: 'enqueued', dispatch_owner: null, fenced_until: null };
        return this.rowToTaskLaunchDispatch(reset);
      });
    });
  }

  private rowToTaskLaunchDispatch(row: Record<string, unknown>): TaskLaunchDispatch {
    return mapRowToTaskLaunchDispatch(row);
  }

  listWorkflowMutationLeases(): WorkflowMutationLease[] {
    return this.queryAll(
      'SELECT * FROM workflow_mutation_leases ORDER BY workflow_id ASC',
    ).map((row) => this.rowToWorkflowMutationLease(row));
  }

  requeueExpiredWorkflowMutationLeases(now: Date = new Date()): number {
    const expiredRows = this.queryAll(
      'SELECT workflow_id FROM workflow_mutation_leases WHERE lease_expires_at < ?',
      [now.toISOString()],
    );
    const workflowIds = expiredRows.map((row) => String(row.workflow_id));
    for (const workflowId of workflowIds) {
      this.requeueWorkflowMutationLease(workflowId);
    }
    return workflowIds.length;
  }

  completeWorkflowMutationIntent(id: number): void {
    this.execRun(
      `UPDATE workflow_mutation_intents
         SET status = 'completed', completed_at = ?, error = NULL
       WHERE id = ?`,
      [new Date().toISOString(), id],
    );
  }

  failWorkflowMutationIntent(id: number, error: string): void {
    this.execRun(
      `UPDATE workflow_mutation_intents
         SET status = 'failed', completed_at = ?, error = ?
       WHERE id = ?`,
      [new Date().toISOString(), error, id],
    );
  }

  private rowToWorkflowMutationIntent(row: Record<string, unknown>): WorkflowMutationIntent {
    return mapRowToWorkflowMutationIntent(row);
  }

  private rowToWorkflowMutationLease(row: Record<string, unknown>): WorkflowMutationLease {
    return mapRowToWorkflowMutationLease(row);
  }

  private requeueWorkflowMutationLease(workflowId: string): void {
    this.execRun(
      `UPDATE workflow_mutation_intents
         SET status = 'queued', owner_id = NULL, started_at = NULL, completed_at = NULL, error = NULL
       WHERE workflow_id = ? AND status = 'running'`,
      [workflowId],
    );
    this.execRun(
      'DELETE FROM workflow_mutation_leases WHERE workflow_id = ?',
      [workflowId],
    );
  }
}
