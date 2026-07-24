import type { SqliteExecutor } from './sqlite-executor.js';

export type SyncEntityType = 'workflow' | 'task' | 'attempt' | 'event' | 'output';
export type SyncJournalOperation = 'upsert' | 'tombstone';

export interface SyncJournalEntryInput {
  entityType: SyncEntityType;
  entityId: string;
  op: SyncJournalOperation;
  payload: unknown;
  origin?: string;
  createdAt?: number;
}

export interface SyncJournalEntry {
  seq: number;
  entityType: SyncEntityType;
  entityId: string;
  op: SyncJournalOperation;
  payload: unknown;
  origin: string;
  createdAt: number;
}

export interface SyncCursor {
  peerId: string;
  lastSentSeq: number;
  lastReceivedSeq: number;
  updatedAt: number;
}

export type SyncCursorInput = Omit<SyncCursor, 'updatedAt'> & {
  updatedAt?: number;
};

type RawStatement = {
  get?: (...params: unknown[]) => Record<string, unknown> | undefined;
  all?: (...params: unknown[]) => Record<string, unknown>[];
  step?: () => boolean;
  getAsObject?: () => Record<string, unknown>;
  free?: () => void;
};

type RawSqliteLike = {
  run(sql: string, params?: unknown[]): void;
  prepare(sql: string): RawStatement;
  getRowsModified?: () => number;
};

export type SyncJournalDatabase = SqliteExecutor | RawSqliteLike;

const ENTITY_TYPES: Record<SyncEntityType, true> = {
  workflow: true,
  task: true,
  attempt: true,
  event: true,
  // Reserved for future output-spool journaling. The adapter intentionally
  // does not append output journal entries yet because those rows are high-volume.
  output: true,
};

const OPS: Record<SyncJournalOperation, true> = {
  upsert: true,
  tombstone: true,
};

function isExecutor(db: SyncJournalDatabase): db is SqliteExecutor {
  return 'execRun' in db && typeof db.execRun === 'function';
}

function runWrite(db: SyncJournalDatabase, sql: string, params: unknown[] = []): void {
  if (isExecutor(db)) {
    db.execRun(sql, params);
    return;
  }
  db.run(sql, params);
}

function queryOne(db: SyncJournalDatabase, sql: string, params: unknown[] = []): Record<string, unknown> | undefined {
  if (isExecutor(db)) {
    return db.queryOne(sql, params);
  }
  const stmt = db.prepare(sql);
  try {
    if (typeof stmt.get === 'function') {
      return stmt.get(...params);
    }
    if (typeof stmt.step === 'function' && typeof stmt.getAsObject === 'function') {
      return stmt.step() ? stmt.getAsObject() : undefined;
    }
    throw new Error('SQLite statement does not support single-row reads');
  } finally {
    stmt.free?.();
  }
}

function queryAll(db: SyncJournalDatabase, sql: string, params: unknown[] = []): Record<string, unknown>[] {
  if (isExecutor(db)) {
    return db.queryAll(sql, params);
  }
  const stmt = db.prepare(sql);
  try {
    if (typeof stmt.all === 'function') {
      return stmt.all(...params);
    }
    if (typeof stmt.step === 'function' && typeof stmt.getAsObject === 'function') {
      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    }
    throw new Error('SQLite statement does not support multi-row reads');
  } finally {
    stmt.free?.();
  }
}

function normalizeNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function normalizeOrigin(origin: string | undefined): string {
  const normalized = origin ?? 'home';
  if (normalized.length === 0) {
    throw new Error('sync journal origin must be a non-empty string');
  }
  return normalized;
}

function validateJournalInput(entry: SyncJournalEntryInput): void {
  if (ENTITY_TYPES[entry.entityType] !== true) {
    throw new Error(`Invalid sync journal entity type: ${String(entry.entityType)}`);
  }
  if (OPS[entry.op] !== true) {
    throw new Error(`Invalid sync journal operation: ${String(entry.op)}`);
  }
  if (typeof entry.entityId !== 'string' || entry.entityId.length === 0) {
    throw new Error('sync journal entityId must be a non-empty string');
  }
  if (entry.createdAt !== undefined) {
    normalizeNonNegativeInteger(entry.createdAt, 'createdAt');
  }
}

function parseJournalRow(row: Record<string, unknown>): SyncJournalEntry {
  const seq = Number(row.seq);
  const createdAt = Number(row.created_at);
  const payloadRaw = row.payload;
  if (typeof payloadRaw !== 'string') {
    throw new Error(`Invalid sync journal payload for seq ${seq}`);
  }
  return {
    seq,
    entityType: String(row.entity_type) as SyncEntityType,
    entityId: String(row.entity_id),
    op: String(row.op) as SyncJournalOperation,
    payload: JSON.parse(payloadRaw),
    origin: String(row.origin),
    createdAt,
  };
}

export function appendJournalEntry(
  db: SyncJournalDatabase,
  entry: SyncJournalEntryInput,
): SyncJournalEntry {
  validateJournalInput(entry);
  const createdAt = entry.createdAt ?? Date.now();
  const origin = normalizeOrigin(entry.origin);
  const payload = JSON.stringify(entry.payload ?? null);

  runWrite(
    db,
    `INSERT INTO sync_journal (entity_type, entity_id, op, payload, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [entry.entityType, entry.entityId, entry.op, payload, origin, createdAt],
  );

  const seq = Number(queryOne(db, 'SELECT last_insert_rowid() AS seq')?.seq ?? 0);
  return {
    seq,
    entityType: entry.entityType,
    entityId: entry.entityId,
    op: entry.op,
    payload: JSON.parse(payload),
    origin,
    createdAt,
  };
}

export function readJournalSince(
  db: SyncJournalDatabase,
  seq: number,
  limit: number,
): SyncJournalEntry[] {
  const sinceSeq = normalizeNonNegativeInteger(seq, 'seq');
  const cappedLimit = normalizeNonNegativeInteger(limit, 'limit');
  if (cappedLimit === 0) return [];

  const rows = queryAll(
    db,
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [sinceSeq, cappedLimit],
  );
  return rows.map((row) => parseJournalRow(row));
}

export function getSyncCursor(db: SyncJournalDatabase, peerId: string): SyncCursor | undefined {
  if (peerId.length === 0) {
    throw new Error('sync cursor peerId must be a non-empty string');
  }
  const row = queryOne(
    db,
    `SELECT peer_id, last_sent_seq, last_received_seq, updated_at
       FROM sync_cursors
      WHERE peer_id = ?`,
    [peerId],
  );
  if (!row) return undefined;
  return {
    peerId: String(row.peer_id),
    lastSentSeq: Number(row.last_sent_seq ?? 0),
    lastReceivedSeq: Number(row.last_received_seq ?? 0),
    updatedAt: Number(row.updated_at),
  };
}

export function setSyncCursor(db: SyncJournalDatabase, cursor: SyncCursorInput): void {
  if (cursor.peerId.length === 0) {
    throw new Error('sync cursor peerId must be a non-empty string');
  }
  const lastSentSeq = normalizeNonNegativeInteger(cursor.lastSentSeq, 'lastSentSeq');
  const lastReceivedSeq = normalizeNonNegativeInteger(cursor.lastReceivedSeq, 'lastReceivedSeq');
  const updatedAt = normalizeNonNegativeInteger(cursor.updatedAt ?? Date.now(), 'updatedAt');
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
}
