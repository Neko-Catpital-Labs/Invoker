import type { SqliteExecutor } from './sqlite-executor.js';

export const SYNC_ENTITY_TYPES = [
  'workflow',
  'task',
  'attempt',
  'event',
  // Reserved for future output-spool synchronization. Output rows are not
  // journaled yet because they are high-volume and need a separate policy.
  'output',
] as const;

export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];
export type SyncJournalOperation = 'upsert' | 'tombstone';

export interface SyncJournalEntryInput {
  entityType: SyncEntityType;
  entityId: string;
  op: SyncJournalOperation;
  payload: unknown;
  origin?: string;
  createdAt?: string;
}

export interface SyncJournalEntry {
  seq: number;
  entityType: SyncEntityType;
  entityId: string;
  op: SyncJournalOperation;
  payload: unknown;
  origin: string;
  createdAt: string;
}

export interface SyncCursor {
  peerId: string;
  lastSentSeq: number;
  lastReceivedSeq: number;
  updatedAt: string;
}

export interface SyncCursorWrite {
  peerId: string;
  lastSentSeq?: number;
  lastReceivedSeq?: number;
  updatedAt?: string;
}

type StatementLike = {
  get?: (...params: unknown[]) => Record<string, unknown> | undefined;
  all?: (...params: unknown[]) => Record<string, unknown>[];
  run?: (...params: unknown[]) => unknown;
  bind?: (params?: unknown[]) => void;
  step?: () => boolean;
  getAsObject?: () => Record<string, unknown>;
  free?: () => void;
};

type RawDbLike = {
  prepare?: (sql: string) => StatementLike;
  run?: (sql: string, params?: unknown[]) => unknown;
};

export type SyncJournalDb = SqliteExecutor | RawDbLike;

function isSqliteExecutor(db: SyncJournalDb): db is SqliteExecutor {
  const candidate = db as Partial<SqliteExecutor>;
  return typeof candidate.execRun === 'function'
    && typeof candidate.queryOne === 'function'
    && typeof candidate.queryAll === 'function';
}

function prepareRaw(db: RawDbLike, sql: string): StatementLike {
  if (!db.prepare) {
    throw new Error('sync journal db must provide prepare() or SqliteExecutor methods');
  }
  return db.prepare(sql);
}

function finalize(stmt: StatementLike): void {
  if (stmt.free) stmt.free();
}

function rawQueryOne(db: RawDbLike, sql: string, params: unknown[]): Record<string, unknown> | undefined {
  const stmt = prepareRaw(db, sql);
  try {
    if (stmt.get) {
      return stmt.get(...params);
    }
    if (stmt.bind && stmt.step && stmt.getAsObject) {
      stmt.bind(params);
      return stmt.step() ? stmt.getAsObject() : undefined;
    }
    throw new Error('sync journal statement must provide get() or step()/getAsObject()');
  } finally {
    finalize(stmt);
  }
}

function rawQueryAll(db: RawDbLike, sql: string, params: unknown[]): Record<string, unknown>[] {
  const stmt = prepareRaw(db, sql);
  try {
    if (stmt.all) {
      return stmt.all(...params);
    }
    if (stmt.bind && stmt.step && stmt.getAsObject) {
      stmt.bind(params);
      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      return rows;
    }
    throw new Error('sync journal statement must provide all() or step()/getAsObject()');
  } finally {
    finalize(stmt);
  }
}

function queryOne(db: SyncJournalDb, sql: string, params: unknown[] = []): Record<string, unknown> | undefined {
  return isSqliteExecutor(db) ? db.queryOne(sql, params) : rawQueryOne(db, sql, params);
}

function queryAll(db: SyncJournalDb, sql: string, params: unknown[] = []): Record<string, unknown>[] {
  return isSqliteExecutor(db) ? db.queryAll(sql, params) : rawQueryAll(db, sql, params);
}

function runWrite(db: SyncJournalDb, sql: string, params: unknown[] = []): void {
  if (isSqliteExecutor(db)) {
    db.execRun(sql, params);
    return;
  }
  if (db.run) {
    db.run(sql, params);
    return;
  }
  const stmt = prepareRaw(db, sql);
  try {
    if (!stmt.run) {
      throw new Error('sync journal statement must provide run()');
    }
    stmt.run(...params);
  } finally {
    finalize(stmt);
  }
}

function requireEntityType(value: SyncEntityType): SyncEntityType {
  if (!SYNC_ENTITY_TYPES.includes(value)) {
    throw new Error(`Invalid sync journal entity type: ${String(value)}`);
  }
  return value;
}

function requireOperation(value: SyncJournalOperation): SyncJournalOperation {
  if (value !== 'upsert' && value !== 'tombstone') {
    throw new Error(`Invalid sync journal operation: ${String(value)}`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return normalized;
}

function parseJournalRow(row: Record<string, unknown>): SyncJournalEntry {
  const seq = nonNegativeInteger(row.seq, 'seq');
  const entityType = String(row.entity_type) as SyncEntityType;
  const op = String(row.op) as SyncJournalOperation;
  let payload: unknown;
  try {
    payload = JSON.parse(String(row.payload));
  } catch (err) {
    throw new Error(
      `Invalid sync journal payload JSON at seq ${seq}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return {
    seq,
    entityType: requireEntityType(entityType),
    entityId: String(row.entity_id),
    op: requireOperation(op),
    payload,
    origin: String(row.origin),
    createdAt: String(row.created_at),
  };
}

function parseCursorRow(row: Record<string, unknown>): SyncCursor {
  return {
    peerId: String(row.peer_id),
    lastSentSeq: nonNegativeInteger(row.last_sent_seq, 'lastSentSeq'),
    lastReceivedSeq: nonNegativeInteger(row.last_received_seq, 'lastReceivedSeq'),
    updatedAt: String(row.updated_at),
  };
}

export function appendJournalEntry(db: SyncJournalDb, entry: SyncJournalEntryInput): number {
  const payloadJson = JSON.stringify(entry.payload);
  if (payloadJson === undefined) {
    throw new Error('sync journal payload must be JSON-serializable');
  }
  const createdAt = entry.createdAt ?? new Date().toISOString();
  const origin = entry.origin ?? 'home';
  runWrite(
    db,
    `INSERT INTO sync_journal (entity_type, entity_id, op, payload, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      requireEntityType(entry.entityType),
      entry.entityId,
      requireOperation(entry.op),
      payloadJson,
      origin,
      createdAt,
    ],
  );
  const row = queryOne(db, 'SELECT last_insert_rowid() AS seq');
  return nonNegativeInteger(row?.seq, 'seq');
}

export function readJournalSince(db: SyncJournalDb, seq: number, limit: number): SyncJournalEntry[] {
  const cursor = nonNegativeInteger(Math.trunc(seq), 'seq');
  const cappedLimit = Math.trunc(limit);
  if (!Number.isFinite(cappedLimit) || cappedLimit <= 0) return [];
  const rows = queryAll(
    db,
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
     FROM sync_journal
     WHERE seq > ?
     ORDER BY seq ASC
     LIMIT ?`,
    [cursor, cappedLimit],
  );
  return rows.map((row) => parseJournalRow(row));
}

export function getSyncCursor(db: SyncJournalDb, peerId: string): SyncCursor | undefined {
  const row = queryOne(
    db,
    `SELECT peer_id, last_sent_seq, last_received_seq, updated_at
     FROM sync_cursors
     WHERE peer_id = ?`,
    [peerId],
  );
  return row ? parseCursorRow(row) : undefined;
}

export function setSyncCursor(db: SyncJournalDb, cursor: SyncCursorWrite): SyncCursor {
  const existing = getSyncCursor(db, cursor.peerId);
  const lastSentSeq = nonNegativeInteger(cursor.lastSentSeq ?? existing?.lastSentSeq ?? 0, 'lastSentSeq');
  const lastReceivedSeq = nonNegativeInteger(
    cursor.lastReceivedSeq ?? existing?.lastReceivedSeq ?? 0,
    'lastReceivedSeq',
  );
  const updatedAt = cursor.updatedAt ?? new Date().toISOString();
  runWrite(
    db,
    `INSERT INTO sync_cursors (peer_id, last_sent_seq, last_received_seq, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(peer_id) DO UPDATE SET
       last_sent_seq = excluded.last_sent_seq,
       last_received_seq = excluded.last_received_seq,
       updated_at = excluded.updated_at`,
    [cursor.peerId, lastSentSeq, lastReceivedSeq, updatedAt],
  );
  const saved = getSyncCursor(db, cursor.peerId);
  if (!saved) {
    throw new Error(`Failed to persist sync cursor for peer ${cursor.peerId}`);
  }
  return saved;
}
