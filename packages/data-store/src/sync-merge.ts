import type { AttemptStatus, TaskStatus, WorkflowDerivedStatus } from '@invoker/workflow-core';
import type { SqliteExecutor } from './sqlite-executor.js';
import { DELTA_BATCH_SCHEMA_VERSION, type DeltaBatch } from './sync-delta.js';
import {
  appendJournalEntry,
  getSyncCursor,
  setSyncCursor,
  type SyncEntityType,
  type SyncJournalEntry,
} from './sync-journal.js';

export interface ApplyDeltaResult {
  appliedEntries: number;
  skippedEntries: number;
  lastReceivedSeq: number;
}

type RowPayload = Record<string, unknown>;

const WORKFLOW_COLUMNS = [
  'id',
  'name',
  'description',
  'visual_proof',
  'plan_file',
  'repo_url',
  'intermediate_repo_url',
  'branch',
  'on_finish',
  'base_branch',
  'parent_remote',
  'feature_branch',
  'merge_mode',
  'review_provider',
  'external_dependencies',
  'external_dependency_changes',
  'detached_external_dependencies',
  'generation',
  'deleted_at',
  'created_at',
  'updated_at',
] as const;

const TASK_COLUMNS = [
  'id',
  'workflow_id',
  'description',
  'status',
  'blocked_by',
  'dependencies',
  'command',
  'prompt',
  'experiment_prompt',
  'exit_code',
  'error',
  'protocol_error_code',
  'protocol_error_message',
  'input_prompt',
  'external_dependencies',
  'summary',
  'problem',
  'approach',
  'test_plan',
  'repro_command',
  'fix_prompt',
  'fix_context',
  'branch',
  'commit_hash',
  'fixed_integration_sha',
  'fixed_integration_recorded_at',
  'fixed_integration_source',
  'parent_task',
  'pivot',
  'experiment_variants',
  'is_reconciliation',
  'selected_experiment',
  'selected_experiments',
  'experiment_results',
  'requires_manual_approval',
  'repo_url',
  'feature_branch',
  'is_merge_node',
  'auto_fix',
  'max_fix_attempts',
  'runner_kind',
  'pool_id',
  'claude_session_id',
  'agent_session_id',
  'workspace_path',
  'container_id',
  'last_agent_session_id',
  'last_agent_name',
  'action_request_id',
  'experiments',
  'created_at',
  'launch_phase',
  'launch_started_at',
  'launch_completed_at',
  'started_at',
  'completed_at',
  'last_heartbeat_at',
  'utilization',
  'pending_fix_error',
  'fix_session_entry_status',
  'failure_class',
  'review_url',
  'review_id',
  'review_status',
  'review_provider_id',
  'review_gate',
  'is_fixing_with_ai',
  'execution_generation',
  'selected_attempt_id',
  'pool_member_id',
  'docker_image',
  'execution_agent',
  'execution_model',
  'agent_name',
  'task_state_version',
] as const;

const ATTEMPT_COLUMNS = [
  'id',
  'node_id',
  'attempt_number',
  'queue_priority',
  'status',
  'snapshot_commit',
  'base_branch',
  'upstream_attempt_ids',
  'command_override',
  'prompt_override',
  'claimed_at',
  'started_at',
  'completed_at',
  'exit_code',
  'error',
  'last_heartbeat_at',
  'lease_expires_at',
  'branch',
  'commit_hash',
  'summary',
  'workspace_path',
  'claude_session_id',
  'agent_session_id',
  'container_id',
  'supersedes_attempt_id',
  'created_at',
  'merge_conflict',
] as const;

const EVENT_COLUMNS = ['id', 'task_id', 'event_type', 'payload', 'created_at'] as const;
const OUTPUT_COLUMNS = ['id', 'task_id', 'offset', 'data', 'created_at'] as const;

const JSON_COLUMNS = new Set<string>([
  'dependencies',
  'external_dependencies',
  'external_dependency_changes',
  'detached_external_dependencies',
  'experiment_variants',
  'selected_experiments',
  'experiment_results',
  'experiments',
  'review_gate',
  'upstream_attempt_ids',
  'merge_conflict',
  'payload',
]);

const BOOLEAN_COLUMNS = new Set<string>([
  'visual_proof',
  'pivot',
  'is_reconciliation',
  'requires_manual_approval',
  'is_merge_node',
  'auto_fix',
  'is_fixing_with_ai',
]);

const TASK_STATUS_RANK: Record<string, number> = {
  pending: 0,
  queued: 1,
  blocked: 1,
  running: 2,
  needs_input: 3,
  awaiting_approval: 4,
  review_ready: 5,
  fixing_with_ai: 6,
  failed: 7,
  closed: 8,
  cancelled: 8,
  canceled: 8,
  stale: 9,
  completed: 10,
};

const WORKFLOW_STATUS_RANK: Record<string, number> = {
  pending: 0,
  blocked: 1,
  running: 2,
  awaiting_approval: 4,
  review_ready: 5,
  fixing_with_ai: 6,
  failed: 7,
  closed: 8,
  cancelled: 8,
  canceled: 8,
  stale: 9,
  completed: 10,
};

const ATTEMPT_STATUS_RANK: Record<string, number> = {
  pending: 0,
  claimed: 1,
  running: 2,
  needs_input: 3,
  superseded: 4,
  failed: 4,
  cancelled: 4,
  canceled: 4,
  completed: 5,
};

function assertSupportedBatch(batch: DeltaBatch): void {
  if (!batch || typeof batch !== 'object') {
    throw new Error('Delta batch must be an object');
  }
  if (batch.schemaVersion !== DELTA_BATCH_SCHEMA_VERSION) {
    throw new Error(`Unsupported delta schema version ${String(batch.schemaVersion)}`);
  }
  if (!Number.isInteger(batch.highWaterSeq) || batch.highWaterSeq < 0) {
    throw new Error('Delta batch highWaterSeq must be a non-negative integer');
  }
  if (!Array.isArray(batch.entries)) {
    throw new Error('Delta batch entries must be an array');
  }
  const maxEntrySeq = Math.max(0, ...batch.entries.map((entry) => entry.seq));
  if (maxEntrySeq > batch.highWaterSeq) {
    throw new Error('Delta batch contains entries beyond highWaterSeq');
  }
}

function asPayload(value: unknown, entityType: SyncEntityType, entityId: string): RowPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Delta ${entityType} ${entityId} payload must be an object`);
  }
  return value as RowPayload;
}

function text(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function requiredText(value: unknown, name: string): string {
  const out = text(value);
  if (!out) throw new Error(`${name} is required`);
  return out;
}

function integer(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const out = Number(value);
  return Number.isInteger(out) ? out : undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sqlIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function tableColumns(db: SqliteExecutor, table: string): Set<string> {
  const rows = db.queryAll(`PRAGMA table_info(${sqlIdentifier(table)})`);
  return new Set(rows.map((row) => String(row.name)));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonical(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeColumnValue(column: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (BOOLEAN_COLUMNS.has(column)) {
    return value ? 1 : 0;
  }
  if (JSON_COLUMNS.has(column) && value !== null && value !== undefined && typeof value !== 'string') {
    return JSON.stringify(value);
  }
  return value ?? null;
}

function withDefaults(payload: RowPayload, defaults: RowPayload): RowPayload {
  return { ...defaults, ...payload };
}

function rowForColumns(
  payload: RowPayload,
  allowedColumns: readonly string[],
  existingColumns: Set<string>,
): { columns: string[]; values: unknown[] } {
  const columns = allowedColumns.filter((column) => existingColumns.has(column) && column in payload);
  return {
    columns,
    values: columns.map((column) => normalizeColumnValue(column, payload[column])),
  };
}

function upsertPayloadRow(
  db: SqliteExecutor,
  table: string,
  keyColumn: string,
  allowedColumns: readonly string[],
  payload: RowPayload,
): void {
  const existingColumns = tableColumns(db, table);
  const { columns, values } = rowForColumns(payload, allowedColumns, existingColumns);
  if (!columns.includes(keyColumn)) {
    throw new Error(`Delta payload for ${table} is missing ${keyColumn}`);
  }
  const quotedColumns = columns.map(sqlIdentifier);
  const updateColumns = columns.filter((column) => column !== keyColumn);
  const updateSql = updateColumns
    .map((column) => `${sqlIdentifier(column)} = excluded.${sqlIdentifier(column)}`)
    .join(', ');
  db.execRun(
    `INSERT INTO ${sqlIdentifier(table)} (${quotedColumns.join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})
     ON CONFLICT(${sqlIdentifier(keyColumn)}) DO ${updateSql ? `UPDATE SET ${updateSql}` : 'NOTHING'}`,
    values,
  );
}

function insertAppendOnlyRow(
  db: SqliteExecutor,
  table: string,
  keyColumn: string,
  allowedColumns: readonly string[],
  payload: RowPayload,
): boolean {
  const existingColumns = tableColumns(db, table);
  const { columns, values } = rowForColumns(payload, allowedColumns, existingColumns);
  if (!columns.includes(keyColumn)) {
    throw new Error(`Delta payload for ${table} is missing ${keyColumn}`);
  }
  const before = db.queryOne(
    `SELECT ${sqlIdentifier(keyColumn)} FROM ${sqlIdentifier(table)} WHERE ${sqlIdentifier(keyColumn)} = ?`,
    [payload[keyColumn]],
  );
  if (before) return false;
  db.execRun(
    `INSERT OR IGNORE INTO ${sqlIdentifier(table)} (${columns.map(sqlIdentifier).join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})`,
    values,
  );
  return db.getRowsModified() > 0;
}

function defaultWorkflow(id: string, deletedAt?: number): RowPayload {
  const createdAt = deletedAt ? new Date(deletedAt).toISOString() : nowIso();
  return {
    id,
    name: id,
    visual_proof: 0,
    generation: 0,
    deleted_at: deletedAt ?? null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function ensureWorkflow(db: SqliteExecutor, workflowId: string, deletedAt?: number): void {
  const existing = db.queryOne('SELECT id, deleted_at FROM workflows WHERE id = ?', [workflowId]) as
    | { id?: string; deleted_at?: unknown }
    | undefined;
  if (!existing) {
    upsertPayloadRow(db, 'workflows', 'id', WORKFLOW_COLUMNS, defaultWorkflow(workflowId, deletedAt));
    return;
  }
  if (deletedAt !== undefined && (existing.deleted_at === null || existing.deleted_at === undefined)) {
    const updatedAt = new Date(deletedAt).toISOString();
    db.execRun('UPDATE workflows SET deleted_at = ?, updated_at = ? WHERE id = ?', [
      deletedAt,
      updatedAt,
      workflowId,
    ]);
  }
}

function workflowDeletedAt(db: SqliteExecutor, workflowId: string): number | undefined {
  const row = db.queryOne('SELECT deleted_at FROM workflows WHERE id = ?', [workflowId]) as
    | { deleted_at?: unknown }
    | undefined;
  return integer(row?.deleted_at);
}

function normalizeTaskStatus(value: unknown): TaskStatus | string {
  const raw = String(value ?? 'pending');
  if (raw === 'cancelled' || raw === 'canceled') return 'closed';
  return raw;
}

function normalizeWorkflowStatus(value: unknown): WorkflowDerivedStatus | string {
  const raw = String(value ?? 'pending');
  if (raw === 'cancelled' || raw === 'canceled') return 'closed';
  return raw;
}

function normalizeAttemptStatus(value: unknown): AttemptStatus | string {
  const raw = String(value ?? 'pending');
  if (raw === 'cancelled' || raw === 'canceled') return 'failed';
  return raw;
}

function statusRank(status: unknown, ranks: Record<string, number>): number {
  return ranks[String(status)] ?? -1;
}

function chooseByStatusThenCanonical(
  local: RowPayload | undefined,
  incoming: RowPayload,
  statusColumn: string,
  ranks: Record<string, number>,
  normalizeStatus: (value: unknown) => string,
): RowPayload {
  if (!local) return incoming;
  const localStatus = normalizeStatus(local[statusColumn]);
  const incomingStatus = normalizeStatus(incoming[statusColumn]);
  const localRank = statusRank(localStatus, ranks);
  const incomingRank = statusRank(incomingStatus, ranks);
  if (incomingRank > localRank) return { ...incoming, [statusColumn]: incomingStatus };
  if (incomingRank < localRank) return { ...local, [statusColumn]: localStatus };
  return canonical({ ...incoming, [statusColumn]: incomingStatus }) > canonical({ ...local, [statusColumn]: localStatus })
    ? { ...incoming, [statusColumn]: incomingStatus }
    : { ...local, [statusColumn]: localStatus };
}

function hasSamePersistedPayload(
  db: SqliteExecutor,
  table: string,
  keyColumn: string,
  keyValue: unknown,
  payload: RowPayload,
  allowedColumns: readonly string[],
): boolean {
  const existing = db.queryOne(
    `SELECT * FROM ${sqlIdentifier(table)} WHERE ${sqlIdentifier(keyColumn)} = ?`,
    [keyValue],
  );
  if (!existing) return false;
  const existingColumns = tableColumns(db, table);
  const comparableColumns = allowedColumns.filter(
    (column) => existingColumns.has(column) && column in payload,
  );
  return comparableColumns.every((column) => {
    const expected = normalizeColumnValue(column, payload[column]);
    const actual = normalizeColumnValue(column, existing[column]);
    return canonical(actual) === canonical(expected);
  });
}

function applyWorkflowUpsert(db: SqliteExecutor, entry: SyncJournalEntry, tombstone: boolean): boolean {
  const payload = asPayload(entry.payload, entry.entityType, entry.entityId);
  const id = requiredText(payload.id ?? entry.entityId, 'workflow id');
  const existing = db.queryOne('SELECT * FROM workflows WHERE id = ?', [id]);
  const incomingDeletedAt = integer(payload.deleted_at);
  const existingDeletedAt = integer(existing?.deleted_at);
  if (existingDeletedAt !== undefined && !tombstone && incomingDeletedAt === undefined) {
    return false;
  }
  const deletedAt = tombstone
    ? incomingDeletedAt !== undefined && existingDeletedAt !== undefined
      ? Math.max(incomingDeletedAt, existingDeletedAt)
      : incomingDeletedAt ?? existingDeletedAt ?? Date.now()
    : existingDeletedAt ?? incomingDeletedAt;
  const statusWinner = chooseByStatusThenCanonical(
    existing,
    withDefaults(payload, defaultWorkflow(id, deletedAt)),
    'status',
    WORKFLOW_STATUS_RANK,
    (value) => normalizeWorkflowStatus(value),
  );
  const merged = {
    ...statusWinner,
    id,
    deleted_at: deletedAt ?? null,
    updated_at: text(statusWinner.updated_at) ?? (deletedAt ? new Date(deletedAt).toISOString() : nowIso()),
  };
  if (hasSamePersistedPayload(db, 'workflows', 'id', id, merged, WORKFLOW_COLUMNS)) return false;
  upsertPayloadRow(db, 'workflows', 'id', WORKFLOW_COLUMNS, merged);
  return true;
}

function applyWorkflowTombstone(db: SqliteExecutor, entry: SyncJournalEntry): boolean {
  return applyWorkflowUpsert(db, entry, true);
}

function applyTaskUpsert(db: SqliteExecutor, entry: SyncJournalEntry): boolean {
  const payload = asPayload(entry.payload, entry.entityType, entry.entityId);
  const id = requiredText(payload.id ?? entry.entityId, 'task id');
  const workflowId = requiredText(payload.workflow_id, `task ${id} workflow_id`);
  ensureWorkflow(db, workflowId, workflowDeletedAt(db, workflowId));
  const existing = db.queryOne('SELECT * FROM tasks WHERE id = ?', [id]);
  const incoming = withDefaults(payload, {
    id,
    workflow_id: workflowId,
    description: id,
    status: 'pending',
    dependencies: '[]',
    created_at: nowIso(),
    execution_generation: 0,
    task_state_version: 1,
  });
  const winner = chooseByStatusThenCanonical(
    existing,
    { ...incoming, status: normalizeTaskStatus(incoming.status) },
    'status',
    TASK_STATUS_RANK,
    (value) => normalizeTaskStatus(value),
  );
  const mergedWorkflowId = text(winner.workflow_id) ?? workflowId;
  ensureWorkflow(db, mergedWorkflowId, workflowDeletedAt(db, mergedWorkflowId));
  const merged = {
    ...winner,
    id,
    workflow_id: mergedWorkflowId,
  };
  if (hasSamePersistedPayload(db, 'tasks', 'id', id, merged, TASK_COLUMNS)) return false;
  upsertPayloadRow(db, 'tasks', 'id', TASK_COLUMNS, merged);
  return true;
}

function applyAttemptUpsert(db: SqliteExecutor, entry: SyncJournalEntry): boolean {
  const payload = asPayload(entry.payload, entry.entityType, entry.entityId);
  const id = requiredText(payload.id ?? entry.entityId, 'attempt id');
  const nodeId = requiredText(payload.node_id, `attempt ${id} node_id`);
  const existingTask = db.queryOne('SELECT id FROM tasks WHERE id = ?', [nodeId]);
  if (!existingTask) {
    throw new Error(`Cannot apply attempt ${id}: task ${nodeId} is missing`);
  }
  const existing = db.queryOne('SELECT * FROM attempts WHERE id = ?', [id]);
  const incoming = withDefaults(payload, {
    id,
    node_id: nodeId,
    attempt_number: 0,
    queue_priority: 0,
    status: 'pending',
    upstream_attempt_ids: '[]',
    created_at: nowIso(),
  });
  const winner = chooseByStatusThenCanonical(
    existing,
    { ...incoming, status: normalizeAttemptStatus(incoming.status) },
    'status',
    ATTEMPT_STATUS_RANK,
    (value) => normalizeAttemptStatus(value),
  );
  const mergedNodeId = text(winner.node_id) ?? nodeId;
  const merged = {
    ...winner,
    id,
    node_id: mergedNodeId,
  };
  if (hasSamePersistedPayload(db, 'attempts', 'id', id, merged, ATTEMPT_COLUMNS)) return false;
  upsertPayloadRow(db, 'attempts', 'id', ATTEMPT_COLUMNS, merged);
  return true;
}

function applyEventUpsert(db: SqliteExecutor, entry: SyncJournalEntry): boolean {
  const payload = asPayload(entry.payload, entry.entityType, entry.entityId);
  const id = integer(payload.id ?? entry.entityId);
  if (id === undefined) throw new Error(`event ${entry.entityId} id must be an integer`);
  const taskId = requiredText(payload.task_id, `event ${id} task_id`);
  const existingTask = db.queryOne('SELECT id FROM tasks WHERE id = ?', [taskId]);
  if (!existingTask) {
    throw new Error(`Cannot apply event ${id}: task ${taskId} is missing`);
  }
  const row = withDefaults(payload, {
    id,
    task_id: taskId,
    event_type: 'sync.event',
    created_at: nowIso(),
  });
  return insertAppendOnlyRow(db, 'events', 'id', EVENT_COLUMNS, row);
}

function applyOutputUpsert(db: SqliteExecutor, entry: SyncJournalEntry): boolean {
  const payload = asPayload(entry.payload, entry.entityType, entry.entityId);
  const id = integer(payload.id ?? entry.entityId);
  const taskId = requiredText(payload.task_id, `output ${entry.entityId} task_id`);
  const existingTask = db.queryOne('SELECT id FROM tasks WHERE id = ?', [taskId]);
  if (!existingTask) {
    throw new Error(`Cannot apply output ${entry.entityId}: task ${taskId} is missing`);
  }

  if (id !== undefined) {
    const row = withDefaults(payload, {
      id,
      task_id: taskId,
      offset: 0,
      data: '',
      created_at: nowIso(),
    });
    return insertAppendOnlyRow(db, 'output_spool', 'id', OUTPUT_COLUMNS, row);
  }

  const offset = integer(payload.offset);
  if (offset === undefined) {
    throw new Error(`output ${entry.entityId} requires an integer id or offset`);
  }
  const existing = db.queryOne(
    'SELECT id FROM output_spool WHERE task_id = ? AND offset = ?',
    [taskId, offset],
  );
  if (existing) return false;
  const row = withDefaults(payload, {
    task_id: taskId,
    offset,
    data: '',
    created_at: nowIso(),
  });
  const columns = OUTPUT_COLUMNS.filter((column) => column !== 'id');
  const existingColumns = tableColumns(db, 'output_spool');
  const selected = rowForColumns(row, columns, existingColumns);
  db.execRun(
    `INSERT INTO output_spool (${selected.columns.map(sqlIdentifier).join(', ')})
     VALUES (${selected.columns.map(() => '?').join(', ')})`,
    selected.values,
  );
  return true;
}

function applyEntry(db: SqliteExecutor, entry: SyncJournalEntry): boolean {
  switch (entry.entityType) {
    case 'workflow':
      return entry.op === 'tombstone'
        ? applyWorkflowTombstone(db, entry)
        : applyWorkflowUpsert(db, entry, false);
    case 'task':
      if (entry.op === 'tombstone') return false;
      return applyTaskUpsert(db, entry);
    case 'attempt':
      if (entry.op === 'tombstone') return false;
      return applyAttemptUpsert(db, entry);
    case 'event':
      if (entry.op === 'tombstone') return false;
      return applyEventUpsert(db, entry);
    case 'output':
      if (entry.op === 'tombstone') return false;
      return applyOutputUpsert(db, entry);
    default:
      throw new Error(`Unsupported sync entity type ${(entry as { entityType?: unknown }).entityType}`);
  }
}

export function applyDelta(db: SqliteExecutor, batch: DeltaBatch, peerId: string): ApplyDeltaResult {
  if (!peerId) throw new Error('peerId is required');
  assertSupportedBatch(batch);

  return db.runTransaction(() => {
    const cursor = getSyncCursor(db, peerId);
    const lastReceivedSeq = cursor?.lastReceivedSeq ?? 0;
    const entries = batch.entries
      .filter((entry) => entry.seq > lastReceivedSeq)
      .sort((a, b) => a.seq - b.seq);
    let appliedEntries = 0;
    let skippedEntries = batch.entries.length - entries.length;

    for (const entry of entries) {
      const changed = applyEntry(db, entry);
      if (!changed) {
        skippedEntries += 1;
        continue;
      }
      appendJournalEntry(db, {
        entityType: entry.entityType,
        entityId: entry.entityId,
        op: entry.op,
        payload: entry.payload,
        origin: peerId,
        createdAt: entry.createdAt,
      });
      appliedEntries += 1;
    }

    const nextReceivedSeq = Math.max(lastReceivedSeq, batch.highWaterSeq);
    const saved = setSyncCursor(db, {
      peerId,
      lastReceivedSeq: nextReceivedSeq,
      lastSentSeq: cursor?.lastSentSeq ?? 0,
      updatedAt: nowIso(),
    });

    return {
      appliedEntries,
      skippedEntries,
      lastReceivedSeq: saved.lastReceivedSeq,
    };
  });
}
