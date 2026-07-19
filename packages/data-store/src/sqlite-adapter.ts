/**
 * SQLiteAdapter — PersistenceAdapter backed by native SQLite.
 *
 * Uses `:memory:` for testing, file path for production.
 * Construction remains async for API compatibility, all operations after init are synchronous.
 */

import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type {
  TaskState,
  TaskStateChanges,
  Attempt,
  ExternalDependencyChange,
  DetachedExternalDependency,
} from '@invoker/workflow-core';
import { DISPATCH_LEASE_MS } from '@invoker/contracts';
import type { InAppPlanningChatLine, InAppPlanningPlanSummary, InAppPlanningSessionStatus, PlanningTerminalMode, SearchResultItem, SearchOptions } from '@invoker/contracts';
import type {
  ExecutionResourceLeaseReleaseRow,
  LaunchDispatchInvalidationRow,
  PersistenceAdapter,
  ReviewGateLookup,
  Workflow,
  WorkflowSaveInput,
  WorkflowTaskSnapshot,
  TaskEvent,
  TaskEventListFilters,
  ActivityLogEntry,
  Conversation,
  ConversationMessage,
  WorkflowChannel,
  WorkerActionListFilters,
  WorkerActionRecord,
  WorkerActionWrite,
  WorkerDesiredStateRecord,
  TerminalSessionPatch,
  TerminalSessionRecord,
  InAppPlanningSessionPatch,
  InAppPlanningSessionRecord,
} from './adapter.js';
import type { CostAttributionAttempt } from './attempt-read-models.js';
import { SCHEMA_DDL } from './sqlite-schema.js';
import {
  mapRowToTaskLaunchDispatch,
  mapRowToWorkflowMutationIntent,
  mapRowToWorkflowMutationLease,
  mapRowToWorkerAction,
} from './sqlite-row-mappers.js';
import {
  taskOutputFilePath,
  taskSpoolFilePath,
  encodeSpoolLine,
  readSpoolLinesFromFile,
  readLastSpoolLinesFromFile,
} from './sqlite-output-spool.js';
import { SlowQueryAggregator, type SlowQueryShapeStats } from './slow-query-aggregator.js';
import type { SqliteExecutor } from './sqlite-executor.js';
import * as migrations from './sqlite-migrations.js';
import { SqliteTaskAttemptRepository } from './sqlite-task-attempt-repository.js';
import { SqliteWorkflowRepository, type WorkflowMetadataChanges } from './sqlite-workflow-repository.js';

function normalizeWorkerActionStatus(status: string): string {
  return status === 'canceled' ? 'cancelled' : status;
}

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

export interface OutputChunk {
  offset: number;
  data: string;
}

const SQLITE_EPHEMERAL_DATABASE = ':memory:';

function ownerMarkerPath(dbPath: string): string {
  return `${dbPath}.owner`;
}

/**
 * PID of the writable owner currently holding `dbPath`, or null when none is
 * live. A marker left behind by a crashed owner reports null so a dead process
 * can never lock readers out permanently.
 */
function readLiveOwnerPid(dbPath: string): number | null {
  const marker = ownerMarkerPath(dbPath);
  if (!existsSync(marker)) return null;
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(marker, 'utf-8').trim(), 10);
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (pid === process.pid) return pid;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

export function hasLiveWritableOwner(dbPath: string): boolean {
  const sidecarsExist = existsSync(`${dbPath}-wal`) || existsSync(`${dbPath}-shm`);
  return sidecarsExist && readLiveOwnerPid(dbPath) !== null;
}

function writeOwnerMarker(dbPath: string): void {
  try {
    writeFileSync(ownerMarkerPath(dbPath), String(process.pid), 'utf-8');
  } catch (err) {
    console.warn(
      `[SQLiteAdapter] Could not write owner marker for ${dbPath}: ${err instanceof Error ? err.message : String(err)}. ` +
      'Read-only opens cannot detect this owner and will be allowed alongside it.',
    );
  }
}

function clearOwnerMarker(dbPath: string): void {
  const marker = ownerMarkerPath(dbPath);
  try {
    if (existsSync(marker) && readLiveOwnerPid(dbPath) === process.pid) rmSync(marker, { force: true });
  } catch (err) {
    console.warn(
      `[SQLiteAdapter] Could not clear owner marker for ${dbPath}: ${err instanceof Error ? err.message : String(err)}. ` +
      'A stale marker is ignored once this PID exits.',
    );
  }
}

interface SQLiteAdapterOptions {
  readOnly?: boolean;
  ownerCapability?: boolean;
  outputTailLimit?: number;
  outputDir?: string;
  /** Max retained activity_log rows; 0 disables retention. */
  activityLogMaxRows?: number;
  /**
   * Open WAL in exclusive locking mode: the wal-index lives in heap memory and
   * no `-shm` file is created, making the process immune to the SIGBUS that a
   * truncated memory-mapped `-shm` causes. Requires this process to be the SOLE
   * opener of the database file — a concurrent open is rejected with SQLITE_BUSY.
   */
  exclusiveLocking?: boolean;
  slowQueryThresholdMs?: number;
  onSlowQuery?: (info: SlowQueryInfo) => void;
}

export interface SlowQueryInfo {
  durationMs: number;
  sql: string;
  rowCount?: number;
}

export type EphemeralSQLiteAdapterOptions = Pick<
  SQLiteAdapterOptions,
  'outputTailLimit' | 'outputDir' | 'activityLogMaxRows'
>;

const DEFAULT_SLOW_QUERY_SUMMARY_TOP_N = 10;
const DEFAULT_SLOW_QUERY_SUMMARY_INTERVAL_MS = 30_000;
const SLOW_QUERY_SUMMARY_SQL_PREVIEW_LENGTH = 240;

function formatSlowQuerySummaryLine(index: number, stats: SlowQueryShapeStats): string {
  const maxRows = stats.maxRows === undefined ? '' : ` maxRows=${stats.maxRows}`;
  const firstSeen = new Date(stats.firstSeenAtMs).toISOString();
  const lastSeen = new Date(stats.lastSeenAtMs).toISOString();
  const sql = stats.shape.slice(0, SLOW_QUERY_SUMMARY_SQL_PREVIEW_LENGTH);

  return `${index + 1}. max=${stats.maxMs.toFixed(1)}ms p95=${stats.p95Ms.toFixed(1)}ms ` +
    `p50=${stats.p50Ms.toFixed(1)}ms count=${stats.count}${maxRows} ` +
    `seen=${firstSeen}..${lastSeen} sql=${sql}`;
}

function formatSlowQuerySummary(
  thresholdMs: number,
  aggregator: SlowQueryAggregator,
): string {
  const topQueries = aggregator.topN(DEFAULT_SLOW_QUERY_SUMMARY_TOP_N);
  const lines = topQueries.map((stats, index) => formatSlowQuerySummaryLine(index, stats));
  return [
    `[SQLiteAdapter] slow query summary threshold=${thresholdMs.toFixed(1)}ms ` +
      `events=${aggregator.totalCount} shapes=${aggregator.shapeCount} top=${topQueries.length}`,
    ...lines,
  ].join('\n');
}

function createDefaultSlowQuerySink(thresholdMs: number): (info: SlowQueryInfo) => void {
  const aggregator = new SlowQueryAggregator();
  let lastSummaryAtMs = 0;

  return (info) => {
    aggregator.record(info);

    const now = Date.now();
    const shouldSummarize =
      lastSummaryAtMs === 0 || now - lastSummaryAtMs >= DEFAULT_SLOW_QUERY_SUMMARY_INTERVAL_MS;
    if (!shouldSummarize) return;

    console.warn(formatSlowQuerySummary(thresholdMs, aggregator));
    lastSummaryAtMs = now;
  };
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

/**
 * SQLite result codes that mean the database file itself is unreadable and a
 * fresh start is the only recovery: SQLITE_CORRUPT (11) and SQLITE_NOTADB (26).
 * Transient/operational failures (e.g. SQLITE_BUSY=5, SQLITE_LOCKED=6,
 * SQLITE_CANTOPEN=14) MUST NOT trigger destructive recovery: a concurrent
 * process briefly holding a lock would otherwise rename the live database and
 * its -wal/-shm sidecars away, losing data and (because other connections have
 * the -shm memory-mapped) crashing them with SIGBUS.
 */
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;
// Extended result codes pack the primary code in the low 8 bits (e.g.
// SQLITE_CORRUPT_VTAB = 267 -> 267 & 0xff = 11), so mask before comparing or
// extended corruption variants slip through as "not corruption".
const SQLITE_PRIMARY_RESULT_CODE_MASK = 0xff;

/**
 * True when `err` is a SQLite open failure caused by an unreadable database file
 * (SQLITE_CORRUPT / SQLITE_NOTADB, including their extended variants) — the only
 * class of failure for which destructive backup-and-recreate recovery is safe.
 */
export function isDatabaseCorruptionError(err: unknown): boolean {
  const errcode = (err as { errcode?: unknown } | null)?.errcode;
  if (typeof errcode === 'number') {
    const primary = errcode & SQLITE_PRIMARY_RESULT_CODE_MASK;
    return primary === SQLITE_CORRUPT || primary === SQLITE_NOTADB;
  }
  // Fallback for runtimes that do not surface a numeric errcode.
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return message.includes('malformed') || message.includes('not a database');
}

/**
 * Metadata attached to an adapter that opened via the corruption-recovery
 * branch of {@link SQLiteAdapter.create}. `restoredFromSnapshot` is the source
 * of the recovered data when auto-restore succeeded, or `null` when no clean
 * hourly snapshot was available and the adapter fell back to an empty schema.
 * `quarantinedPath` always points at the preserved pre-recovery file so the
 * user can attempt manual `.recover` later.
 */
export interface CorruptionRecovery {
  readonly detectedAt: string;
  readonly quarantinedPath: string;
  readonly restoredFromSnapshot: string | null;
}

/** Prefix produced by `createHourlySnapshot` in `packages/app/src/delete-all-snapshot.ts`. */
const HOURLY_SNAPSHOT_LABEL = 'hourly-auto-';

/**
 * Run `PRAGMA quick_check` on the raw file at `dbPath`. Returns `true` iff the
 * check reports a single `'ok'` row. Any open failure, IO error, or non-ok row
 * yields `false` so callers can treat the file as unusable without unwrapping
 * SQLite error taxonomy. The connection is closed before returning so we never
 * leave a `-shm` mapping on a file we're about to copy or ignore.
 */
async function fileQuickCheckOk(dbPath: string): Promise<boolean> {
  try {
    const { DatabaseSync } = await loadNativeSqlite();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check?: unknown }>;
      return rows.length === 1 && rows[0]?.quick_check === 'ok';
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/**
 * Find the newest `<dbBasename>.hourly-auto-*` file in `backupDir` whose
 * `quick_check` passes. Returns `null` when the directory is missing, has no
 * matching snapshots, or every candidate is corrupt. Snapshot names embed an
 * ISO-derived timestamp (`YYYYMMDD-HHMMSS-mmmZ`), so lexicographic descending
 * order is chronologically newest-first.
 */
async function findLatestCleanHourlySnapshot(
  backupDir: string,
  dbBasename: string,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = readdirSync(backupDir);
  } catch {
    return null;
  }
  const prefix = `${dbBasename}.${HOURLY_SNAPSHOT_LABEL}`;
  const snapshots = entries
    .filter((name) => name.startsWith(prefix) && !name.endsWith('-wal') && !name.endsWith('-shm'))
    .sort()
    .reverse();
  for (const name of snapshots) {
    const candidate = join(backupDir, name);
    if (await fileQuickCheckOk(candidate)) return candidate;
  }
  return null;
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

type TerminalSessionRow = {
  session_id?: unknown;
  task_id?: unknown;
  target_key?: unknown;
  status?: unknown;
  exit_code?: unknown;
  cwd?: unknown;
  command?: unknown;
  args_json?: unknown;
  linux_terminal_tail?: unknown;
  mode?: unknown;
  attached?: unknown;
  output_snapshot?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
};

type InAppPlanningSessionRow = {
  session_id?: unknown;
  title?: unknown;
  preset_key?: unknown;
  status?: unknown;
  draft_plan_summary_json?: unknown;
  submitted_workflow_id?: unknown;
  submitted_plan_name?: unknown;
  terminal_mode?: unknown;
  terminal_session_id?: unknown;
  terminal_status?: unknown;
  terminal_exit_code?: unknown;
  terminal_output_snapshot?: unknown;
  terminal_updated_at?: unknown;
  pending_response?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
};

type InAppPlanningMessageRow = {
  session_id?: unknown;
  message_id?: unknown;
  role?: unknown;
  text?: unknown;
  tone?: unknown;
  created_at?: unknown;
};

function parseTerminalArgsJson(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

function isInAppPlanningSessionStatus(value: unknown): value is InAppPlanningSessionStatus {
  return value === 'still_discussing'
    || value === 'waiting_for_answer'
    || value === 'draft_ready'
    || value === 'submitted';
}

function isPlanningTerminalMode(value: unknown): value is PlanningTerminalMode {
  return value === 'chat' || value === 'tmux';
}

function isPlanningTerminalStatus(value: unknown): value is 'running' | 'exited' | undefined {
  return value === undefined || value === null || value === 'running' || value === 'exited';
}

function isInAppPlanningMessageRole(value: unknown): value is InAppPlanningChatLine['role'] {
  return value === 'user' || value === 'assistant' || value === 'system';
}

function isInAppPlanningMessageTone(value: unknown): value is InAppPlanningChatLine['tone'] {
  return value === undefined
    || value === null
    || value === 'muted'
    || value === 'error'
    || value === 'success';
}

function parseInAppPlanningPlanSummary(value: unknown): InAppPlanningPlanSummary | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('planning summary must be an object');
  }
  const candidate = parsed as Partial<InAppPlanningPlanSummary>;
  if (
    typeof candidate.name !== 'string'
    || typeof candidate.taskCount !== 'number'
    || !Array.isArray(candidate.steps)
    || !candidate.steps.every((step) => typeof step === 'string')
    || (
      candidate.workflowCount !== undefined
      && typeof candidate.workflowCount !== 'number'
    )
  ) {
    throw new Error('planning summary has invalid shape');
  }
  const taskGroups = Array.isArray(candidate.taskGroups)
    ? candidate.taskGroups.filter(
      (group): group is InAppPlanningPlanSummary['taskGroups'][number] =>
        !!group
        && typeof group === 'object'
        && (group.workflow === null || typeof group.workflow === 'string')
        && Array.isArray(group.tasks)
        && group.tasks.every((task) => typeof task === 'string'),
    )
    : [];
  return {
    name: candidate.name,
    taskCount: candidate.taskCount,
    ...(candidate.workflowCount === undefined ? {} : { workflowCount: candidate.workflowCount }),
    steps: candidate.steps,
    taskGroups,
  };
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
  private readonly activityLogMaxRows: number;
  private activityLogWritesSincePrune = 0;
  private eventCounterFallbackLogged = false;
  private readonly exclusiveLocking: boolean;
  private readonly taskAttemptRepo: SqliteTaskAttemptRepository;
  private readonly workflowRepo: SqliteWorkflowRepository;
  private readonly slowQueryThresholdMs: number;
  private readonly onSlowQuery: ((info: SlowQueryInfo) => void) | null;

  /**
   * Non-null only when this adapter was opened via the corruption-recovery
   * branch of {@link SQLiteAdapter.create}. Callers (e.g. `main.ts`) surface
   * this to the user so a silent auto-restore or empty-DB fallback is never
   * invisible again. Field, not method, so it's cheap to check on every boot.
   */
  readonly corruptionRecovery: CorruptionRecovery | null;

  /** Use SQLiteAdapter.create() instead. */
  private constructor(
    db: DatabaseSync,
    dbPath: string | null,
    options?: SQLiteAdapterOptions,
    corruptionRecovery: CorruptionRecovery | null = null,
  ) {
    this.nativeDb = db;
    this.db = new NativeDatabaseCompat(db);
    this.dbPath = dbPath;
    this.readOnly = options?.readOnly === true;
    this.outputTailLimit = options?.outputTailLimit ?? 100;
    this.outputDir = options?.outputDir ?? this.resolveOutputDir(dbPath);
    this.activityLogMaxRows = options?.activityLogMaxRows ?? DEFAULT_ACTIVITY_LOG_MAX_ROWS;
    this.exclusiveLocking = options?.exclusiveLocking === true;
    this.slowQueryThresholdMs = options?.slowQueryThresholdMs ?? 25;
    this.onSlowQuery = options?.onSlowQuery
      ?? (this.slowQueryThresholdMs > 0
        ? createDefaultSlowQuerySink(this.slowQueryThresholdMs)
        : null);
    this.corruptionRecovery = corruptionRecovery;
    this.taskAttemptRepo = new SqliteTaskAttemptRepository(this.executor, {
      updateTask: (taskId, changes) => this.updateTask(taskId, changes),
      updateAttempt: (attemptId, changes) => this.updateAttempt(attemptId, changes),
    });
    this.workflowRepo = new SqliteWorkflowRepository(
      this.executor,
      (task) => this.taskAttemptRepo.reconcileTaskFromSelectedAttempt(task),
    );
    this.configureConnection(dbPath !== null);
    if (!this.readOnly) {
      this.initSchema();
      this.migrate();
    }
  }

  private normalizeConversationMode(value: unknown): Conversation['mode'] {
    return value === 'agent' ? 'agent' : 'plan';
  }

  /**
   * Open a private non-file-backed SQLite database.
   *
   * This is for process-local placeholder persistence only. It does not open
   * invoker.db, does not enable WAL, and cannot create or map invoker.db-shm.
   */
  static async createEphemeral(options?: EphemeralSQLiteAdapterOptions): Promise<SQLiteAdapter> {
    return SQLiteAdapter.create(SQLITE_EPHEMERAL_DATABASE, options);
  }

  /**
   * Async factory — opens or creates the database.
   * If the on-disk file is corrupted, backs it up and starts fresh.
   * @param dbPath File path or the private in-memory SQLite database name (default).
   * @param options readOnly=true opens DB for read operations without schema mutation.
   *                ownerCapability=true is required to open DB in writable mode for file-backed databases.
   */
  static async create(
    dbPath: string = SQLITE_EPHEMERAL_DATABASE,
    options?: SQLiteAdapterOptions,
  ): Promise<SQLiteAdapter> {
    const isFile = dbPath !== SQLITE_EPHEMERAL_DATABASE;
    const requestWritable = options?.readOnly !== true;

    // Exclusive (heap wal-index, no -shm) locking is reserved for the sole
    // opener: only the writable owner of a file-backed database may request it.
    // A read-only or non-owner caller opting in would contend with the real
    // owner (SQLITE_BUSY) or get a cryptic open failure.
    if (isFile && options?.exclusiveLocking === true && (!requestWritable || !options?.ownerCapability)) {
      throw new Error(
        'exclusiveLocking requires the writable owner process to be the sole opener of the database file.',
      );
    }

    // Sidecar files alone cannot prove a writable owner is live: opening a
    // WAL-mode database read-only creates -wal/-shm itself, and a read-only
    // connection has no write access to checkpoint them away on close. Gating
    // on mere existence therefore lets the first reader wedge every reader
    // after it. Only a live owner may turn a reader away.
    if (isFile && options?.readOnly === true && (existsSync(`${dbPath}-wal`) || existsSync(`${dbPath}-shm`))) {
      const ownerPid = readLiveOwnerPid(dbPath);
      if (ownerPid !== null) {
        throw new Error(
          `Cannot open SQLite database read-only while writable owner PID ${ownerPid} holds live WAL sidecars for ${dbPath}. ` +
          'Close the writable owner cleanly before opening a file-backed read-only adapter.',
        );
      }
    }

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
      if (isFile && requestWritable && options?.ownerCapability) writeOwnerMarker(dbPath);
      return new SQLiteAdapter(db, isFile ? dbPath : null, options);
    } catch (err) {
      if (!isFile || options?.readOnly === true || !existsSync(dbPath) || !isDatabaseCorruptionError(err)) {
        throw err;
      }
      const detectedAt = new Date().toISOString();
      const backupPath = `${dbPath}.corrupt-${Date.now()}`;
      console.error(
        `[SQLiteAdapter] Database corrupted (${err instanceof Error ? err.message : String(err)}). ` +
        `Quarantining to ${backupPath}.`,
      );
      renameSync(dbPath, backupPath);
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${dbPath}${suffix}`;
        if (existsSync(sidecar)) renameSync(sidecar, `${backupPath}${suffix}`);
      }

      // Data-preserving recovery: prefer the newest clean hourly snapshot over
      // silently starting empty. The invariant only holds if the snapshot is
      // itself intact (quick_check == ok), so we walk newest-first and skip
      // any candidate whose pages are also damaged.
      const backupDir = join(dirname(dbPath), 'db-backups');
      const cleanSnapshot = await findLatestCleanHourlySnapshot(backupDir, basename(dbPath));
      let restoredFromSnapshot: string | null = null;
      if (cleanSnapshot) {
        try {
          copyFileSync(cleanSnapshot, dbPath);
          restoredFromSnapshot = cleanSnapshot;
          console.error(
            `[SQLiteAdapter] Auto-restored ${dbPath} from clean snapshot ${cleanSnapshot}.`,
          );
        } catch (copyErr) {
          console.error(
            `[SQLiteAdapter] Failed to restore from ${cleanSnapshot}: ` +
              (copyErr instanceof Error ? copyErr.message : String(copyErr)) +
              '. Falling back to empty database.',
          );
        }
      } else {
        console.error(
          `[SQLiteAdapter] No clean hourly snapshot in ${backupDir}; starting fresh empty database.`,
        );
      }

      const recovery: CorruptionRecovery = {
        detectedAt,
        quarantinedPath: backupPath,
        restoredFromSnapshot,
      };
      const { DatabaseSync } = await loadNativeSqlite();
      const db = new DatabaseSync(dbPath);
      return new SQLiteAdapter(db, dbPath, options, recovery);
    }
  }

  /**
   * Cheap ("~milliseconds on hundreds of MB") integrity gate for the live
   * connection. Returns `true` iff SQLite's `PRAGMA quick_check` produces a
   * single `'ok'` row. Callers use this to refuse destructive downstream work
   * on a damaged DB — most importantly, to skip the hourly snapshot when the
   * source is corrupt (otherwise the corruption propagates into every backup
   * and defeats the auto-restore invariant in {@link SQLiteAdapter.create}).
   */
  quickCheck(): boolean {
    try {
      const rows = this.nativeDb.prepare('PRAGMA quick_check').all() as Array<{ quick_check?: unknown }>;
      return rows.length === 1 && rows[0]?.quick_check === 'ok';
    } catch {
      return false;
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
      if (this.exclusiveLocking) {
        // Heap wal-index (no -shm file). MUST precede `journal_mode = WAL`.
        this.nativeDb.exec('PRAGMA locking_mode = EXCLUSIVE');
      }
      this.nativeDb.exec('PRAGMA journal_mode = WAL');
      this.nativeDb.exec('PRAGMA synchronous = FULL');
      this.nativeDb.exec('PRAGMA wal_autocheckpoint = 1000');
    }
  }

  // ── SQLite Helpers ───────────────────────────────────────

  private noteSlowQuery(startedAt: number, sql: string, rowCount?: number): void {
    if (this.slowQueryThresholdMs <= 0 || !this.onSlowQuery) return;
    const durationMs = performance.now() - startedAt;
    if (durationMs < this.slowQueryThresholdMs) return;
    this.onSlowQuery({ durationMs, sql, ...(rowCount === undefined ? {} : { rowCount }) });
  }

  /** Run a single-row SELECT, returning the row as an object or undefined. */
  private queryOne(sql: string, params: unknown[] = []): Record<string, unknown> | undefined {
    const startedAt = performance.now();
    const stmt = this.db.prepare(sql);
    try {
      const row = stmt.get(...(paramsToArgs(params) as any[])) as Record<string, unknown> | undefined;
      this.noteSlowQuery(startedAt, sql, row === undefined ? 0 : 1);
      return row;
    } finally {
      stmt.free();
    }
  }

  /** Run a multi-row SELECT, returning an array of row objects. */
  private queryAll(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    const startedAt = performance.now();
    const stmt = this.db.prepare(sql);
    try {
      const rows = stmt.all(...(paramsToArgs(params) as any[])) as Record<string, unknown>[];
      this.noteSlowQuery(startedAt, sql, rows.length);
      return rows;
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
    const startedAt = performance.now();
    this.db.run(sql, params as any[]);
    this.noteSlowQuery(startedAt, sql);
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

  private get executor(): SqliteExecutor {
    return {
      queryOne: (sql, params) => this.queryOne(sql, params),
      queryAll: (sql, params) => this.queryAll(sql, params),
      execRun: (sql, params) => this.execRun(sql, params),
      runTransaction: <T>(work: () => T): T => this.runTransaction<T>(work),
      run: (sql, params) => this.db.run(sql, params),
      getRowsModified: () => this.db.getRowsModified(),
      readOnly: this.readOnly,
      markDirty: () => {
        this.dirty = true;
      },
    };
  }

  runCompatibilityMigration(): {
    migratedFixingWithAiStatuses: number;
    normalizedMergeModes: number;
    staleAutoFixExperimentTasks: number;
    normalizedStaleLaunchMetadata: number;
    normalizedLegacyAcknowledgedLaunchDispatches: number;
    backfilledMissingSshPoolMemberIds: number;
  } {
    return migrations.runCompatibilityMigration(this.executor);
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

  private migrate(): void {
    migrations.migrate(this.executor, () => this.reconcileTerminalSessionInvariants());
  }

  private migrateWorkflowStatusColumn(): void {
    migrations.migrateWorkflowStatusColumn(this.executor);
  }

  private dropTaskAutoFixAttemptsColumn(): void {
    migrations.dropTaskAutoFixAttemptsColumn(this.executor);
  }

  private migrateTestCommands(): void {
    migrations.migrateTestCommands(this.executor);
  }

  private migrateGatePolicyApprovedToCompleted(): void {
    migrations.migrateGatePolicyApprovedToCompleted(this.executor);
  }

  private migrateTaskExternalDependenciesToWorkflows(): void {
    migrations.migrateTaskExternalDependenciesToWorkflows(this.executor);
  }

  private reconcileTerminalSessionInvariants(): void {
    const rows = this.queryAll(
      `SELECT session_id, target_key
       FROM terminal_sessions
       WHERE status = 'running'
       ORDER BY target_key ASC, updated_at DESC, created_at DESC, session_id DESC`,
    ) as Array<{ session_id: string; target_key: string }>;

    const seenTargets = new Set<string>();
    const now = new Date().toISOString();
    for (const row of rows) {
      if (!row.target_key || !row.session_id) continue;
      if (!seenTargets.has(row.target_key)) {
        seenTargets.add(row.target_key);
        continue;
      }
      this.db.run(
        `UPDATE terminal_sessions
            SET status = 'exited',
                updated_at = ?
          WHERE session_id = ?`,
        [now, row.session_id],
      );
    }

    this.db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_sessions_running_target
         ON terminal_sessions(target_key)
         WHERE status = 'running'`,
    );
  }

  // ── Workflows ─────────────────────────────────────────

  saveWorkflow(workflow: WorkflowSaveInput): void {
    this.workflowRepo.saveWorkflow(workflow);
  }

  updateWorkflow(workflowId: string, changes: WorkflowMetadataChanges): void {
    this.workflowRepo.updateWorkflow(workflowId, changes);
  }

  loadWorkflow(workflowId: string): Workflow | undefined {
    return this.workflowRepo.loadWorkflow(workflowId);
  }

  listWorkflows(): Workflow[] {
    return this.workflowRepo.listWorkflows();
  }

  findReviewGateByPr(pr: string): ReviewGateLookup | undefined {
    return this.workflowRepo.findReviewGateByPr(pr);
  }

  searchWorkflowsAndTasks(query: string, opts?: SearchOptions): SearchResultItem[] {
    return this.workflowRepo.searchWorkflowsAndTasks(query, opts);
  }

  loadWorkflowTaskSnapshot(): WorkflowTaskSnapshot {
    return this.workflowRepo.loadWorkflowTaskSnapshot();
  }

  getLastWorkflowTaskSnapshotStats(): Record<string, unknown> | null {
    return this.workflowRepo.getLastWorkflowTaskSnapshotStats();
  }

  // ── Tasks ─────────────────────────────────────────────

  saveTask(workflowId: string, task: TaskState): void {
    this.taskAttemptRepo.saveTask(workflowId, task);
  }

  updateTask(taskId: string, changes: TaskStateChanges): void {
    this.taskAttemptRepo.updateTask(taskId, changes);
  }

  loadTasks(workflowId: string): TaskState[] {
    return this.taskAttemptRepo.loadTasks(workflowId);
  }

  loadTask(taskId: string): TaskState | undefined {
    return this.taskAttemptRepo.loadTask(taskId);
  }

  getAllTaskIds(): string[] {
    return this.taskAttemptRepo.getAllTaskIds();
  }

  getAllTaskBranches(): string[] {
    return this.taskAttemptRepo.getAllTaskBranches();
  }

  upsertTerminalSession(record: TerminalSessionRecord): void {
    this.ensureWritable();
    this.db.run(
      `INSERT INTO terminal_sessions (
        session_id,
        task_id,
        target_key,
        status,
        exit_code,
        cwd,
        command,
        args_json,
        linux_terminal_tail,
        mode,
        attached,
        output_snapshot,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        task_id = excluded.task_id,
        target_key = excluded.target_key,
        status = excluded.status,
        exit_code = excluded.exit_code,
        cwd = excluded.cwd,
        command = excluded.command,
        args_json = excluded.args_json,
        linux_terminal_tail = excluded.linux_terminal_tail,
        mode = excluded.mode,
        attached = excluded.attached,
        output_snapshot = excluded.output_snapshot,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at`,
      [
        record.sessionId,
        record.taskId,
        record.targetKey,
        record.status,
        record.exitCode ?? null,
        record.cwd ?? null,
        record.command ?? null,
        JSON.stringify(record.args ?? []),
        record.linuxTerminalTail ?? null,
        record.mode,
        record.attached ? 1 : 0,
        record.outputSnapshot,
        record.createdAt,
        record.updatedAt,
      ],
    );
    this.dirty = true;
  }

  listTerminalSessions(): TerminalSessionRecord[] {
    const rows = this.queryAll(
      'SELECT * FROM terminal_sessions ORDER BY updated_at ASC, created_at ASC',
    ) as TerminalSessionRow[];
    const records: TerminalSessionRecord[] = [];
    for (const row of rows) {
      const record = this.mapTerminalSessionRow(row);
      if (record) records.push(record);
    }
    return records;
  }

  loadTerminalSession(sessionId: string): TerminalSessionRecord | undefined {
    const row = this.queryOne('SELECT * FROM terminal_sessions WHERE session_id = ?', [sessionId]);
    return row ? this.mapTerminalSessionRow(row as TerminalSessionRow) : undefined;
  }

  updateTerminalSession(sessionId: string, patch: TerminalSessionPatch): void {
    this.ensureWritable();
    const setClauses: string[] = [];
    const values: unknown[] = [];
    if (Object.hasOwn(patch, 'status')) {
      setClauses.push('status = ?');
      values.push(patch.status ?? null);
    }
    if (Object.hasOwn(patch, 'exitCode')) {
      setClauses.push('exit_code = ?');
      values.push(patch.exitCode ?? null);
    }
    if (Object.hasOwn(patch, 'outputSnapshot')) {
      setClauses.push('output_snapshot = ?');
      values.push(patch.outputSnapshot ?? '');
    }
    if (Object.hasOwn(patch, 'updatedAt')) {
      setClauses.push('updated_at = ?');
      values.push(patch.updatedAt ?? null);
    }
    if (setClauses.length === 0) return;
    values.push(sessionId);
    this.db.run(`UPDATE terminal_sessions SET ${setClauses.join(', ')} WHERE session_id = ?`, values);
    this.dirty = true;
  }

  deleteTerminalSession(sessionId: string): void {
    this.ensureWritable();
    this.db.run('DELETE FROM terminal_sessions WHERE session_id = ?', [sessionId]);
    this.dirty = true;
  }

  upsertInAppPlanningSession(record: InAppPlanningSessionRecord): void {
    this.runTransaction(() => {
      this.db.run(
        `INSERT INTO in_app_planning_sessions (
          session_id,
          title,
          preset_key,
          status,
          draft_plan_summary_json,
          submitted_workflow_id,
          submitted_plan_name,
          terminal_mode,
          terminal_session_id,
          terminal_status,
          terminal_exit_code,
          terminal_output_snapshot,
          terminal_updated_at,
          pending_response,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          title = excluded.title,
          preset_key = excluded.preset_key,
          status = excluded.status,
          draft_plan_summary_json = excluded.draft_plan_summary_json,
          submitted_workflow_id = excluded.submitted_workflow_id,
          submitted_plan_name = excluded.submitted_plan_name,
          terminal_mode = excluded.terminal_mode,
          terminal_session_id = excluded.terminal_session_id,
          terminal_status = excluded.terminal_status,
          terminal_exit_code = excluded.terminal_exit_code,
          terminal_output_snapshot = excluded.terminal_output_snapshot,
          terminal_updated_at = excluded.terminal_updated_at,
          pending_response = excluded.pending_response,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at`,
        [
          record.id,
          record.title,
          record.presetKey,
          record.status,
          record.draftPlanSummary ? JSON.stringify(record.draftPlanSummary) : null,
          record.submittedWorkflowId ?? null,
          record.submittedPlanName ?? null,
          record.terminalMode ?? 'chat',
          record.terminalSessionId ?? null,
          record.terminalStatus ?? null,
          record.terminalExitCode ?? null,
          record.terminalOutputSnapshot ?? '',
          record.terminalUpdatedAt ?? null,
          record.pendingResponse ? 1 : 0,
          record.createdAt,
          record.updatedAt,
        ],
      );
      this.replaceInAppPlanningMessages(record.id, record.messages, record.updatedAt);
    });
  }

  listInAppPlanningSessions(): InAppPlanningSessionRecord[] {
    const rows = this.queryAll(
      'SELECT * FROM in_app_planning_sessions ORDER BY updated_at DESC, created_at DESC',
    ) as InAppPlanningSessionRow[];
    const records: InAppPlanningSessionRecord[] = [];
    for (const row of rows) {
      const record = this.mapInAppPlanningSessionRow(row);
      if (record) records.push(record);
    }
    return records;
  }

  loadInAppPlanningSession(sessionId: string): InAppPlanningSessionRecord | undefined {
    const row = this.queryOne('SELECT * FROM in_app_planning_sessions WHERE session_id = ?', [sessionId]);
    return row ? this.mapInAppPlanningSessionRow(row as InAppPlanningSessionRow) : undefined;
  }

  updateInAppPlanningSession(sessionId: string, patch: InAppPlanningSessionPatch): void {
    this.ensureWritable();
    const updateSession = (): void => {
      const setClauses: string[] = [];
      const values: unknown[] = [];
      if (Object.hasOwn(patch, 'title')) {
        setClauses.push('title = ?');
        values.push(patch.title ?? null);
      }
      if (Object.hasOwn(patch, 'status')) {
        setClauses.push('status = ?');
        values.push(patch.status ?? null);
      }
      if (Object.hasOwn(patch, 'draftPlanSummary')) {
        setClauses.push('draft_plan_summary_json = ?');
        values.push(patch.draftPlanSummary ? JSON.stringify(patch.draftPlanSummary) : null);
      }
      if (Object.hasOwn(patch, 'submittedWorkflowId')) {
        setClauses.push('submitted_workflow_id = ?');
        values.push(patch.submittedWorkflowId ?? null);
      }
      if (Object.hasOwn(patch, 'submittedPlanName')) {
        setClauses.push('submitted_plan_name = ?');
        values.push(patch.submittedPlanName ?? null);
      }
      if (Object.hasOwn(patch, 'terminalMode')) {
        setClauses.push('terminal_mode = ?');
        values.push(patch.terminalMode ?? 'chat');
      }
      if (Object.hasOwn(patch, 'terminalSessionId')) {
        setClauses.push('terminal_session_id = ?');
        values.push(patch.terminalSessionId ?? null);
      }
      if (Object.hasOwn(patch, 'terminalStatus')) {
        setClauses.push('terminal_status = ?');
        values.push(patch.terminalStatus ?? null);
      }
      if (Object.hasOwn(patch, 'terminalExitCode')) {
        setClauses.push('terminal_exit_code = ?');
        values.push(patch.terminalExitCode ?? null);
      }
      if (Object.hasOwn(patch, 'terminalOutputSnapshot')) {
        setClauses.push('terminal_output_snapshot = ?');
        values.push(patch.terminalOutputSnapshot ?? '');
      }
      if (Object.hasOwn(patch, 'terminalUpdatedAt')) {
        setClauses.push('terminal_updated_at = ?');
        values.push(patch.terminalUpdatedAt ?? null);
      }
      if (Object.hasOwn(patch, 'pendingResponse')) {
        setClauses.push('pending_response = ?');
        values.push(patch.pendingResponse ? 1 : 0);
      }
      if (Object.hasOwn(patch, 'updatedAt')) {
        setClauses.push('updated_at = ?');
        values.push(patch.updatedAt ?? null);
      }
      if (setClauses.length > 0) {
        values.push(sessionId);
        this.db.run(`UPDATE in_app_planning_sessions SET ${setClauses.join(', ')} WHERE session_id = ?`, values);
      }
      if (patch.messages) {
        const updatedAt = patch.updatedAt ?? new Date().toISOString();
        this.replaceInAppPlanningMessages(sessionId, patch.messages, updatedAt);
      }
    };

    if (patch.messages) {
      this.runTransaction(updateSession);
      return;
    }

    updateSession();
    this.dirty = true;
  }

  deleteInAppPlanningSession(sessionId: string): void {
    this.runTransaction(() => {
      this.db.run('DELETE FROM in_app_planning_messages WHERE session_id = ?', [sessionId]);
      this.db.run('DELETE FROM in_app_planning_sessions WHERE session_id = ?', [sessionId]);
    });
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

  private taskOutputFile(taskId: string): string {
    return taskOutputFilePath(this.outputDir, taskId);
  }

  private taskSpoolFile(taskId: string): string {
    return taskSpoolFilePath(this.outputDir, taskId);
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

  private readSpoolLines(taskId: string): OutputChunk[] {
    return readSpoolLinesFromFile(this.taskSpoolFile(taskId));
  }

  private readLastSpoolLines(taskId: string, limit: number): OutputChunk[] {
    return readLastSpoolLinesFromFile(this.taskSpoolFile(taskId), limit);
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
    return this.taskAttemptRepo.loadAllCompletedTasks();
  }

  loadAllHistoryTasks(): Array<TaskState & { workflowName: string; lastEventAt: string | null; eventCount: number }> {
    return this.taskAttemptRepo.loadAllHistoryTasks();
  }

  deleteTask(taskId: string): void {
    this.runTransaction(() => {
      this.db.run('DELETE FROM task_launch_dispatch WHERE task_id = ?', [taskId]);
      this.db.run('DELETE FROM execution_resource_leases WHERE task_id = ?', [taskId]);
      this.db.run('DELETE FROM events WHERE task_id = ?', [taskId]);
      this.db.run('DELETE FROM task_output WHERE task_id = ?', [taskId]);
      this.db.run('DELETE FROM attempts WHERE node_id = ?', [taskId]);
      this.db.run('DELETE FROM output_spool WHERE task_id = ?', [taskId]);
      this.db.run('DELETE FROM terminal_sessions WHERE task_id = ?', [taskId]);
      this.db.run('DELETE FROM tasks WHERE id = ?', [taskId]);
    });
    this.removeOutputFiles([taskId]);
  }

  deleteAllTasks(workflowId: string): void {
    const taskIds = this.getTaskIdsForWorkflow(workflowId);
    this.runTransaction(() => {
      this.db.run('DELETE FROM workflow_mutation_leases WHERE workflow_id = ?', [workflowId]);
      this.db.run('DELETE FROM workflow_mutation_intents WHERE workflow_id = ?', [workflowId]);
      this.db.run('DELETE FROM task_launch_dispatch WHERE workflow_id = ?', [workflowId]);
      this.db.run(`
        DELETE FROM worker_actions WHERE workflow_id = ? OR task_id IN (
          SELECT id FROM tasks WHERE workflow_id = ?
        )
      `, [workflowId, workflowId]);
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
      this.db.run(`
        DELETE FROM terminal_sessions WHERE task_id IN (
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
      this.db.run('DELETE FROM worker_actions');
      this.db.run('DELETE FROM execution_resource_leases');
      this.db.run('DELETE FROM events');
      // The AFTER DELETE trigger keeps event_type_counters exact on row-by-row
      // deletes, but reset the counters explicitly here so a full wipe is correct
      // even if SQLite ever applies the truncate optimization to the bare DELETE.
      this.db.run('DELETE FROM event_type_counters');
      this.db.run('DELETE FROM task_output');
      this.db.run('DELETE FROM attempts');
      this.db.run('DELETE FROM output_spool');
      this.db.run('DELETE FROM terminal_sessions');
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
        DELETE FROM worker_actions WHERE workflow_id = ? OR task_id IN (
          SELECT id FROM tasks WHERE workflow_id = ?
        )
      `, [workflowId, workflowId]);
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
      this.db.run(`
        DELETE FROM terminal_sessions WHERE task_id IN (
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
  getEvents(taskId: string, sortBy: 'asc' | 'desc', limit: number, beforeId?: number): TaskEvent[];
  getEvents(
    taskId: string,
    sortBy: 'asc' | 'desc' = 'asc',
    limit?: number,
    beforeId?: number,
  ): TaskEvent[] {
    const orderBy = sortBy === 'desc' ? 'DESC' : 'ASC';
    if (limit === undefined) {
      const rows = this.queryAll(
        `SELECT * FROM events WHERE task_id = ? ORDER BY id ${orderBy}`,
        [taskId],
      );
      return rows.map((row: any) => this.rowToTaskEvent(row));
    }
    if (limit <= 0) return [];
    const pageLimit = Math.floor(limit);
    if (beforeId !== undefined) {
      const rows = this.queryAll(
        `SELECT * FROM events WHERE task_id = ? AND id < ? ORDER BY id ${orderBy} LIMIT ?`,
        [taskId, Math.floor(beforeId), pageLimit],
      );
      return rows.map((row: any) => this.rowToTaskEvent(row));
    }
    const rows = this.queryAll(
      `SELECT * FROM events WHERE task_id = ? ORDER BY id ${orderBy} LIMIT ?`,
      [taskId, pageLimit],
    );
    return rows.map((row: any) => this.rowToTaskEvent(row));
  }

  getEventsByTypes(
    eventTypes: readonly string[],
    sortBy: 'asc' | 'desc' = 'desc',
    limit = 50,
  ): TaskEvent[] {
    if (eventTypes.length === 0 || limit <= 0) return [];
    const pageLimit = Math.floor(limit);
    const orderBy = sortBy === 'desc' ? 'DESC' : 'ASC';
    // One multi-type IN + ORDER BY created_at forces USE TEMP B-TREE over every
    // matching row before LIMIT. Query each type via idx_events_type_created
    // with LIMIT, then merge in process.
    const merged: TaskEvent[] = [];
    for (const eventType of eventTypes) {
      const rows = this.queryAll(
        `SELECT * FROM events
         WHERE event_type = ?
         ORDER BY created_at ${orderBy}, id ${orderBy}
         LIMIT ?`,
        [eventType, pageLimit],
      );
      for (const row of rows) {
        merged.push(this.rowToTaskEvent(row));
      }
    }
    merged.sort((a, b) => {
      const byCreated = a.createdAt.localeCompare(b.createdAt);
      if (byCreated !== 0) return sortBy === 'desc' ? -byCreated : byCreated;
      return sortBy === 'desc' ? b.id - a.id : a.id - b.id;
    });
    return merged.slice(0, pageLimit);
  }

  countEventsByTypes(eventTypes: readonly string[]): Array<{
    eventType: string;
    count: number;
    lastCreatedAt: string | null;
  }> {
    if (eventTypes.length === 0) return [];
    const counts = this.readEventTypeCounts(eventTypes);
    return eventTypes.map((eventType) => ({
      eventType,
      count: counts.get(eventType) ?? 0,
      lastCreatedAt: this.maxCreatedAtForEventType(eventType),
    }));
  }

  // Lifetime count per type in O(types): an indexed lookup into the
  // trigger-maintained event_type_counters table instead of a COUNT(*) scan of
  // the events table (linear — ~140ms at 2M rows on the main thread). Falls back
  // to the exact-but-linear COUNT(*) GROUP BY when the counter table is absent —
  // a read-only open of a database written before the backfill migration ran.
  private readEventTypeCounts(eventTypes: readonly string[]): Map<string, number> {
    const placeholders = eventTypes.map(() => '?').join(', ');
    try {
      const rows = this.queryAll(
        `SELECT event_type AS eventType, count
         FROM event_type_counters
         WHERE event_type IN (${placeholders})`,
        [...eventTypes],
      );
      return new Map(rows.map((row) => [String(row.eventType), Number(row.count ?? 0)]));
    } catch (err) {
      if (!this.eventCounterFallbackLogged) {
        this.eventCounterFallbackLogged = true;
        console.warn(
          '[SQLiteAdapter] event_type_counters unavailable; falling back to linear COUNT(*). '
          + `Cause: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const rows = this.queryAll(
        `SELECT event_type AS eventType, COUNT(*) AS count
         FROM events
         WHERE event_type IN (${placeholders})
         GROUP BY event_type`,
        [...eventTypes],
      );
      return new Map(rows.map((row) => [String(row.eventType), Number(row.count ?? 0)]));
    }
  }

  // MAX(created_at) for a single type is an index seek on idx_events_type_created
  // (O(log n)); the grouped form (MAX ... GROUP BY) degrades to a full scan, so
  // resolve one type at a time.
  private maxCreatedAtForEventType(eventType: string): string | null {
    const row = this.queryOne(
      'SELECT MAX(created_at) AS lastCreatedAt FROM events WHERE event_type = ?',
      [eventType],
    );
    return (row?.lastCreatedAt as string | null) ?? null;
  }

  private rowToTaskEvent(row: any): TaskEvent {
    return {
      id: row.id,
      taskId: row.task_id,
      eventType: row.event_type,
      payload: row.payload ?? undefined,
      createdAt: row.created_at,
    };
  }

  listTaskEvents(filters: TaskEventListFilters = {}): TaskEvent[] {
    if (filters.limit !== undefined && Math.floor(filters.limit) <= 0) {
      return [];
    }
    if (filters.eventTypes && filters.eventTypes.length === 0) {
      return [];
    }

    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.taskId) {
      where.push('task_id = ?');
      params.push(filters.taskId);
    }
    if (filters.eventTypes) {
      where.push(`event_type IN (${filters.eventTypes.map(() => '?').join(', ')})`);
      params.push(...filters.eventTypes);
    }

    const orderBy = filters.sortBy === 'asc' ? 'ASC' : 'DESC';
    let limitSql = '';
    if (filters.limit !== undefined) {
      limitSql = ' LIMIT ?';
      params.push(Math.floor(filters.limit));
    }

    const rows = this.queryAll(
      `SELECT * FROM events ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id ${orderBy}${limitSql}`,
      params,
    );
    return rows.map((row: any) => ({
      id: row.id,
      taskId: row.task_id,
      eventType: row.event_type,
      payload: row.payload ?? undefined,
      createdAt: row.created_at,
    }));
  }

  getWorkerAction(workerKind: string, externalKey: string): WorkerActionRecord | undefined {
    const row = this.queryOne(
      'SELECT * FROM worker_actions WHERE worker_kind = ? AND external_key = ?',
      [workerKind, externalKey],
    );
    return row ? this.rowToWorkerAction(row) : undefined;
  }

  upsertWorkerAction(action: WorkerActionWrite): WorkerActionRecord {
    return this.runTransaction(() => {
      const existing = this.queryOne(
        'SELECT id FROM worker_actions WHERE worker_kind = ? AND external_key = ?',
        [action.workerKind, action.externalKey],
      );
      if (existing && String(existing.id) !== action.id) {
        throw new Error(
          `Worker action ${action.workerKind}/${action.externalKey} already exists with id "${String(existing.id)}"`,
        );
      }
      const nowIso = new Date().toISOString();
      const createdAt = action.createdAt ?? nowIso;
      const updatedAt = action.updatedAt ?? nowIso;
      const payloadJson = action.payload === undefined ? null : JSON.stringify(action.payload);
      const status = normalizeWorkerActionStatus(action.status);
      this.execRun(
        `INSERT INTO worker_actions (
          id, worker_kind, action_type, workflow_id, task_id,
          subject_type, subject_id, external_key, status, attempt_count,
          intent_id, agent_name, execution_model, session_id, summary,
          payload_json, created_at, updated_at, completed_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?
        )
        ON CONFLICT(worker_kind, external_key) DO UPDATE SET
          action_type = excluded.action_type,
          workflow_id = excluded.workflow_id,
          task_id = excluded.task_id,
          subject_type = excluded.subject_type,
          subject_id = excluded.subject_id,
          status = excluded.status,
          attempt_count = excluded.attempt_count,
          intent_id = excluded.intent_id,
          agent_name = excluded.agent_name,
          execution_model = excluded.execution_model,
          session_id = excluded.session_id,
          summary = excluded.summary,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at`,
        [
          action.id,
          action.workerKind,
          action.actionType,
          action.workflowId ?? null,
          action.taskId ?? null,
          action.subjectType,
          action.subjectId,
          action.externalKey,
          status,
          action.attemptCount ?? 0,
          action.intentId ?? null,
          action.agentName ?? null,
          action.executionModel ?? null,
          action.sessionId ?? null,
          action.summary ?? null,
          payloadJson,
          createdAt,
          updatedAt,
          action.completedAt ?? null,
        ],
      );
      const saved = this.getWorkerAction(action.workerKind, action.externalKey);
      if (!saved) {
        throw new Error(`Failed to persist worker action ${action.workerKind}/${action.externalKey}`);
      }
      return saved;
    });
  }

  listWorkerActions(filters: WorkerActionListFilters = {}): WorkerActionRecord[] {
    const limit = filters.limit === undefined ? undefined : Math.floor(filters.limit);
    if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
      return [];
    }
    const offset = filters.offset === undefined ? undefined : Math.floor(filters.offset);
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.workflowId) {
      where.push('workflow_id = ?');
      params.push(filters.workflowId);
    }
    if (filters.taskId) {
      where.push('task_id = ?');
      params.push(filters.taskId);
    }
    if (filters.workerKind) {
      where.push('worker_kind = ?');
      params.push(filters.workerKind);
    }
    if (filters.status) {
      where.push('status = ?');
      params.push(normalizeWorkerActionStatus(String(filters.status)));
    }
    if (filters.decision === 'skip') {
      where.push("status = 'skipped'");
    } else if (filters.decision === 'act') {
      where.push("status != 'skipped'");
    }
    let pageSql = '';
    if (limit !== undefined) {
      pageSql = ' LIMIT ?';
      params.push(limit);
    }
    if (offset !== undefined && Number.isFinite(offset) && offset > 0) {
      if (limit === undefined) {
        pageSql = ' LIMIT -1';
      }
      pageSql += ' OFFSET ?';
      params.push(offset);
    }
    const rows = this.queryAll(
      `SELECT * FROM worker_actions ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ` +
        `ORDER BY updated_at DESC, id ASC${pageSql}`,
      params,
    );
    return rows.map((row) => this.rowToWorkerAction(row));
  }

  getWorkerDesiredState(workerKind: string): WorkerDesiredStateRecord | undefined {
    const row = this.queryOne(
      'SELECT worker_kind, desired_enabled, updated_at FROM worker_desired_states WHERE worker_kind = ?',
      [workerKind],
    );
    return row ? this.rowToWorkerDesiredState(row) : undefined;
  }

  setWorkerDesiredState(workerKind: string, desiredEnabled: boolean): WorkerDesiredStateRecord {
    const updatedAt = new Date().toISOString();
    this.execRun(
      `INSERT INTO worker_desired_states (worker_kind, desired_enabled, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(worker_kind) DO UPDATE SET
         desired_enabled = excluded.desired_enabled,
         updated_at = excluded.updated_at`,
      [workerKind, desiredEnabled ? 1 : 0, updatedAt],
    );
    const saved = this.getWorkerDesiredState(workerKind);
    if (!saved) {
      throw new Error(`Failed to persist worker desired state for ${workerKind}`);
    }
    return saved;
  }

  listWorkerDesiredStates(): WorkerDesiredStateRecord[] {
    const rows = this.queryAll(
      'SELECT worker_kind, desired_enabled, updated_at FROM worker_desired_states ORDER BY worker_kind ASC',
    );
    return rows.map((row) => this.rowToWorkerDesiredState(row));
  }

  // ── Queries ─────────────────────────────────────────

  getSelectedExperiment(taskId: string): string | null {
    return this.taskAttemptRepo.getSelectedExperiment(taskId);
  }

  getWorkspacePath(taskId: string): string | null {
    return this.taskAttemptRepo.getWorkspacePath(taskId);
  }

  getAgentSessionId(taskId: string): string | null {
    return this.taskAttemptRepo.getAgentSessionId(taskId);
  }

  getLastAgentSessionId(taskId: string): string | null {
    return this.taskAttemptRepo.getLastAgentSessionId(taskId);
  }

  getRunnerKind(taskId: string): string | null {
    return this.taskAttemptRepo.getRunnerKind(taskId);
  }

  getTaskStatus(taskId: string): string | null {
    return this.taskAttemptRepo.getTaskStatus(taskId);
  }

  getContainerId(taskId: string): string | null {
    return this.taskAttemptRepo.getContainerId(taskId);
  }

  getBranch(taskId: string): string | null {
    return this.taskAttemptRepo.getBranch(taskId);
  }

  getExecutionAgent(taskId: string): string | null {
    return this.taskAttemptRepo.getExecutionAgent(taskId);
  }

  getPoolMemberId(taskId: string): string | null {
    return this.taskAttemptRepo.getPoolMemberId(taskId);
  }

  // ── Conversations ───────────────────────────────────────

  saveConversation(conversation: Conversation): void {
    this.execRun(`
      INSERT OR REPLACE INTO conversations (thread_ts, channel_id, user_id, mode, extracted_plan, plan_submitted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      conversation.threadTs,
      conversation.channelId,
      conversation.userId,
      conversation.mode ?? 'plan',
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
      mode: this.normalizeConversationMode(row.mode),
      extractedPlan: (row.extracted_plan as string) ?? null,
      planSubmitted: row.plan_submitted === 1,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  updateConversation(threadTs: string, changes: Partial<Pick<Conversation, 'mode' | 'extractedPlan' | 'planSubmitted' | 'updatedAt'>>): void {
    const setClauses: string[] = [];
    const values: any[] = [];

    if ('mode' in changes) {
      setClauses.push('mode = ?');
      values.push(changes.mode ?? 'plan');
    }
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
      mode: this.normalizeConversationMode(row.mode),
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

  countMessages(threadTs: string): number {
    const row = this.queryOne(
      'SELECT COUNT(*) AS count FROM conversation_messages WHERE thread_ts = ?',
      [threadTs],
    ) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
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
      return spoolChunks.map((chunk) => chunk.data).join('')
        + this.readLegacyDiagnosticTaskOutputRows(taskId)
        + diagnosticFile;
    }
    const rows = this.queryAll(
      'SELECT data FROM task_output WHERE task_id = ? ORDER BY id ASC',
      [taskId],
    ) as Array<{ data: string }>;
    return rows.map((r) => r.data).join('') + diagnosticFile;
  }

  private readLegacyDiagnosticTaskOutputRows(taskId: string): string {
    const rows = this.queryAll(
      'SELECT data FROM task_output WHERE task_id = ? ORDER BY id ASC',
      [taskId],
    ) as Array<{ data: string }>;
    return rows
      .map((r) => r.data)
      .filter((data) => this.isDiagnosticTaskOutput(data))
      .join('');
  }

  private isDiagnosticTaskOutput(data: string): boolean {
    return data.includes('[Shutdown Diagnostic]')
      || data.includes('[Startup Failure Diagnostic]');
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
    appendFileSync(this.taskSpoolFile(taskId), encodeSpoolLine({ offset: nextOffset, data }), 'utf8');
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
    this.taskAttemptRepo.saveAttempt(attempt);
  }

  loadAttempts(nodeId: string): Attempt[] {
    return this.taskAttemptRepo.loadAttempts(nodeId);
  }

  loadCostAttributionAttempts(nodeId: string): CostAttributionAttempt[] {
    return this.taskAttemptRepo.loadCostAttributionAttempts(nodeId);
  }

  loadActionGraphAttempts(
    nodeId: string,
    selectedAttemptId?: string,
    recentAttemptLimit = ACTION_GRAPH_RECENT_ATTEMPT_LIMIT,
  ): Attempt[] {
    return this.taskAttemptRepo.loadActionGraphAttempts(nodeId, selectedAttemptId, recentAttemptLimit);
  }

  loadAttempt(attemptId: string): Attempt | undefined {
    return this.taskAttemptRepo.loadAttempt(attemptId);
  }

  updateAttempt(attemptId: string, changes: Partial<Pick<Attempt, 'status' | 'claimedAt' | 'startedAt' | 'completedAt' | 'exitCode' | 'error' | 'lastHeartbeatAt' | 'leaseExpiresAt' | 'branch' | 'commit' | 'summary' | 'queuePriority' | 'workspacePath' | 'agentSessionId' | 'containerId' | 'mergeConflict'>>): void {
    this.taskAttemptRepo.updateAttempt(attemptId, changes);
  }

  claimAttemptForLaunch(
    attemptId: string,
    changes: Partial<Pick<Attempt, 'status' | 'claimedAt' | 'startedAt' | 'lastHeartbeatAt' | 'leaseExpiresAt' | 'queuePriority'>>,
    now: Date,
  ): boolean {
    return this.taskAttemptRepo.claimAttemptForLaunch(attemptId, changes, now);
  }

  failTaskAndAttempt(
    taskId: string,
    taskChanges: TaskStateChanges,
    attemptPatch: Partial<Pick<Attempt, 'status' | 'exitCode' | 'error' | 'completedAt'>>
  ): void {
    this.taskAttemptRepo.failTaskAndAttempt(taskId, taskChanges, attemptPatch);
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
    if (this.dbPath && !this.readOnly) {
      clearOwnerMarker(this.dbPath);
    }
  }

  // ── Helpers ───────────────────────────────────────────

  private mapTerminalSessionRow(row: TerminalSessionRow): TerminalSessionRecord | undefined {
    if (row.status !== 'running' && row.status !== 'exited') return undefined;
    if (row.mode !== 'spawn' && row.mode !== 'attached') return undefined;
    const sessionId = typeof row.session_id === 'string' ? row.session_id : '';
    const taskId = typeof row.task_id === 'string' ? row.task_id : '';
    const targetKey = typeof row.target_key === 'string' ? row.target_key : '';
    const createdAt = typeof row.created_at === 'string' ? row.created_at : '';
    const updatedAt = typeof row.updated_at === 'string' ? row.updated_at : '';
    if (!sessionId || !taskId || !targetKey || !createdAt || !updatedAt) return undefined;
    return {
      sessionId,
      taskId,
      targetKey,
      status: row.status,
      exitCode: typeof row.exit_code === 'number' ? row.exit_code : undefined,
      cwd: typeof row.cwd === 'string' ? row.cwd : undefined,
      command: typeof row.command === 'string' ? row.command : undefined,
      args: parseTerminalArgsJson(row.args_json),
      linuxTerminalTail:
        row.linux_terminal_tail === 'exec_bash' || row.linux_terminal_tail === 'pause'
          ? row.linux_terminal_tail
          : undefined,
      mode: row.mode,
      attached: row.attached === 1,
      outputSnapshot: typeof row.output_snapshot === 'string' ? row.output_snapshot : '',
      createdAt,
      updatedAt,
    };
  }

  private replaceInAppPlanningMessages(
    sessionId: string,
    messages: InAppPlanningChatLine[],
    fallbackCreatedAt: string,
  ): void {
    this.db.run('DELETE FROM in_app_planning_messages WHERE session_id = ?', [sessionId]);
    for (const message of messages) {
      this.db.run(
        `INSERT INTO in_app_planning_messages (
          session_id,
          message_id,
          role,
          text,
          tone,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          message.id,
          message.role,
          message.text,
          message.tone ?? null,
          message.createdAt ?? fallbackCreatedAt,
        ],
      );
    }
  }


  private mapInAppPlanningSessionRow(row: InAppPlanningSessionRow): InAppPlanningSessionRecord | undefined {
    try {
      const id = typeof row.session_id === 'string' ? row.session_id : '';
      const title = typeof row.title === 'string' ? row.title : '';
      const presetKey = typeof row.preset_key === 'string' ? row.preset_key : '';
      const createdAt = typeof row.created_at === 'string' ? row.created_at : '';
      const updatedAt = typeof row.updated_at === 'string' ? row.updated_at : '';
      if (!id || !title || !presetKey || !createdAt || !updatedAt || !isInAppPlanningSessionStatus(row.status)) {
        return undefined;
      }
      const terminalMode = row.terminal_mode === undefined || row.terminal_mode === null
        ? 'chat'
        : isPlanningTerminalMode(row.terminal_mode)
          ? row.terminal_mode
          : undefined;
      if (!terminalMode) {
        return undefined;
      }
      if (!isPlanningTerminalStatus(row.terminal_status)) {
        return undefined;
      }
      if (
        row.status === 'submitted'
        && (
          typeof row.submitted_workflow_id !== 'string'
          || typeof row.submitted_plan_name !== 'string'
        )
      ) {
        return undefined;
      }

      const messageRows = this.queryAll(
        'SELECT * FROM in_app_planning_messages WHERE session_id = ? ORDER BY message_id ASC',
        [id],
      ) as InAppPlanningMessageRow[];
      const draftPlanSummary = parseInAppPlanningPlanSummary(row.draft_plan_summary_json);
      const messages: InAppPlanningChatLine[] = [];
      for (const messageRow of messageRows) {
        if (
          typeof messageRow.message_id !== 'number'
          || !isInAppPlanningMessageRole(messageRow.role)
          || typeof messageRow.text !== 'string'
          || typeof messageRow.created_at !== 'string'
          || !isInAppPlanningMessageTone(messageRow.tone)
        ) {
          return undefined;
        }
        messages.push({
          id: messageRow.message_id,
          role: messageRow.role,
          text: messageRow.text,
          ...(messageRow.tone ? { tone: messageRow.tone } : {}),
          createdAt: messageRow.created_at,
        });
      }

      return {
        id,
        title,
        presetKey,
        status: row.status,
        messages,
        ...(draftPlanSummary ? { draftPlanSummary } : {}),
        ...(typeof row.submitted_workflow_id === 'string' ? { submittedWorkflowId: row.submitted_workflow_id } : {}),
        ...(typeof row.submitted_plan_name === 'string' ? { submittedPlanName: row.submitted_plan_name } : {}),
        terminalMode,
        ...(typeof row.terminal_session_id === 'string' ? { terminalSessionId: row.terminal_session_id } : {}),
        ...(row.terminal_status ? { terminalStatus: row.terminal_status } : {}),
        ...(typeof row.terminal_exit_code === 'number' ? { terminalExitCode: row.terminal_exit_code } : {}),
        terminalOutputSnapshot: typeof row.terminal_output_snapshot === 'string' ? row.terminal_output_snapshot : '',
        ...(typeof row.terminal_updated_at === 'string' ? { terminalUpdatedAt: row.terminal_updated_at } : {}),
        pendingResponse: row.pending_response === 1,
        createdAt,
        updatedAt,
      };
    } catch {
      return undefined;
    }
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
    /** Max live holders for this resource key. Default 1 preserves exclusive semantics. */
    maxHolders?: number;
  }): boolean {
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + (options.leaseMs ?? EXECUTION_RESOURCE_LEASE_MS)).toISOString();
    const maxHolders = Math.max(1, Math.floor(options.maxHolders ?? 1));
    return this.runTransaction(() => {
      this.execRun(
        'DELETE FROM execution_resource_leases WHERE resource_key = ? AND lease_expires_at <= ?',
        [options.resourceKey, nowIso],
      );
      const existingForHolder = this.queryOne(
        `SELECT holder_id FROM execution_resource_leases
         WHERE resource_key = ?
           AND holder_id = ?
           AND lease_expires_at > ?
         LIMIT 1`,
        [options.resourceKey, options.holderId, nowIso],
      );
      if (!existingForHolder) {
        const otherHolders = this.queryOne(
          `SELECT COUNT(*) AS cnt FROM execution_resource_leases
           WHERE resource_key = ?
             AND holder_id != ?
             AND lease_expires_at > ?`,
          [options.resourceKey, options.holderId, nowIso],
        );
        const otherCount = Number(otherHolders?.cnt ?? 0);
        if (otherCount >= maxHolders) return false;
      }

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

  countExecutionResourceLeases(resourceKey: string, nowIso?: string): number {
    const cutoff = nowIso ?? new Date().toISOString();
    const row = this.queryOne(
      `SELECT COUNT(*) AS cnt FROM execution_resource_leases
       WHERE resource_key = ?
         AND lease_expires_at > ?`,
      [resourceKey, cutoff],
    );
    return Number(row?.cnt ?? 0);
  }

  listExecutionResourceLeasesByKey(resourceKey: string, nowIso?: string): ExecutionResourceLease[] {
    const cutoff = nowIso ?? new Date().toISOString();
    return this.queryAll(
      `SELECT * FROM execution_resource_leases
       WHERE resource_key = ?
         AND lease_expires_at > ?
       ORDER BY acquired_at ASC`,
      [resourceKey, cutoff],
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

  /**
   * Globally delete expired execution-resource leases. Claim-time reclaim only
   * clears the same `resource_key`; after owner restart, orphaned keys would
   * otherwise sit until something tries that key again.
   */
  releaseExpiredExecutionResourceLeases(nowIso?: string): number {
    const cutoff = nowIso ?? new Date().toISOString();
    this.execRun(
      'DELETE FROM execution_resource_leases WHERE lease_expires_at <= ?',
      [cutoff],
    );
    return (this.db.getRowsModified?.() ?? 0) as number;
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
        const taskStatus = String(candidate.current_task_status ?? '');
        const launchClaimable = taskStatus === 'pending' || taskStatus === 'queued';
        if (!candidate.current_task_id) {
          staleReason = `Launch dispatch ${candidateId} is stale: task ${String(candidate.task_id)} no longer exists`;
        } else if (!launchClaimable) {
          staleReason =
            `Launch dispatch ${candidateId} is stale: task ${String(candidate.task_id)} ` +
            `status is ${taskStatus}`;
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
    maxLaunchAgeMs?: number;
  }): TaskLaunchDispatch[] {
    const now = options.nowIso ?? new Date().toISOString();
    const maxLaunchAgeMs = options.maxLaunchAgeMs;
    const ageCutoff = maxLaunchAgeMs === undefined
      ? null
      : new Date(new Date(now).getTime() - maxLaunchAgeMs).toISOString();
    const rows = this.queryAll(
      `SELECT * FROM task_launch_dispatch
         WHERE state = 'leased'
           AND fenced_until IS NOT NULL
           AND fenced_until < ?
           AND (
             attempts_count >= ?
             OR (? IS NOT NULL AND enqueued_at <= ?)
           )
         ORDER BY id ASC`,
      [now, options.maxAttempts, ageCutoff, ageCutoff],
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

  private rowToWorkerAction(row: Record<string, unknown>): WorkerActionRecord {
    return mapRowToWorkerAction(row);
  }

  private rowToWorkerDesiredState(row: Record<string, unknown>): WorkerDesiredStateRecord {
    return {
      workerKind: String(row.worker_kind),
      desiredEnabled: Number(row.desired_enabled) !== 0,
      updatedAt: String(row.updated_at),
    };
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
