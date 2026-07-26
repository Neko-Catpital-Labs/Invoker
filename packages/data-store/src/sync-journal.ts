import type { SqliteExecutor } from './sqlite-executor.js';

export const SYNC_JOURNAL_ENTITY_TYPES = [
  'workflow',
  'task',
  'attempt',
  'event',
  // Reserved for future output-spool journaling. Writers intentionally do not
  // emit output entries yet because output rows are high volume.
  'output',
] as const;

export type SyncJournalEntityType = typeof SYNC_JOURNAL_ENTITY_TYPES[number];
export type SyncJournalOp = 'upsert' | 'tombstone';

export interface SyncJournalAppendEntry {
  entityType: SyncJournalEntityType;
  entityId: string;
  op: SyncJournalOp;
  payload: unknown;
  origin?: string;
  createdAt?: number;
}

export interface SyncJournalEntry {
  seq: number;
  entityType: SyncJournalEntityType;
  entityId: string;
  op: SyncJournalOp;
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

export interface SyncCursorWrite {
  peerId: string;
  lastSentSeq: number;
  lastReceivedSeq: number;
  updatedAt?: number;
}

function assertNonEmptyString(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertEntityType(value: SyncJournalEntityType): void {
  if (!(SYNC_JOURNAL_ENTITY_TYPES as readonly string[]).includes(value)) {
    throw new Error(`invalid sync journal entity type: ${String(value)}`);
  }
}

function assertOp(value: SyncJournalOp): void {
  if (value !== 'upsert' && value !== 'tombstone') {
    throw new Error(`invalid sync journal op: ${String(value)}`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be an integer >= 0`);
  }
}

function parsePayload(raw: unknown, seq: number): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid sync_journal payload JSON at seq ${seq}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function mapJournalRow(row: Record<string, unknown>): SyncJournalEntry {
  const seq = Number(row.seq);
  return {
    seq,
    entityType: String(row.entity_type) as SyncJournalEntityType,
    entityId: String(row.entity_id),
    op: String(row.op) as SyncJournalOp,
    payload: parsePayload(row.payload, seq),
    origin: String(row.origin),
    createdAt: Number(row.created_at),
  };
}

function mapCursorRow(row: Record<string, unknown>): SyncCursor {
  return {
    peerId: String(row.peer_id),
    lastSentSeq: Number(row.last_sent_seq ?? 0),
    lastReceivedSeq: Number(row.last_received_seq ?? 0),
    updatedAt: Number(row.updated_at),
  };
}

export function appendJournalEntry(db: SqliteExecutor, entry: SyncJournalAppendEntry): number {
  assertEntityType(entry.entityType);
  assertNonEmptyString(entry.entityId, 'sync journal entityId');
  assertOp(entry.op);
  const origin = entry.origin ?? 'home';
  assertNonEmptyString(origin, 'sync journal origin');
  const createdAt = entry.createdAt ?? Date.now();
  assertNonNegativeInteger(createdAt, 'sync journal createdAt');

  const payload = JSON.stringify(entry.payload);
  if (payload === undefined) {
    throw new Error('sync journal payload must be JSON-serializable');
  }

  db.execRun(
    `INSERT INTO sync_journal (entity_type, entity_id, op, payload, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [entry.entityType, entry.entityId, entry.op, payload, origin, createdAt],
  );
  const row = db.queryOne('SELECT last_insert_rowid() AS seq');
  return Number(row?.seq ?? 0);
}

export function readJournalSince(db: SqliteExecutor, seq: number, limit: number): SyncJournalEntry[] {
  assertNonNegativeInteger(seq, 'sync journal seq');
  if (!Number.isInteger(limit)) {
    throw new Error('sync journal limit must be an integer');
  }
  if (limit <= 0) return [];

  const rows = db.queryAll(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [seq, limit],
  );
  return rows.map((row) => mapJournalRow(row));
}

export function getSyncCursor(db: SqliteExecutor, peerId: string): SyncCursor | undefined {
  assertNonEmptyString(peerId, 'sync cursor peerId');
  const row = db.queryOne(
    `SELECT peer_id, last_sent_seq, last_received_seq, updated_at
       FROM sync_cursors
      WHERE peer_id = ?`,
    [peerId],
  );
  return row ? mapCursorRow(row) : undefined;
}

export function setSyncCursor(db: SqliteExecutor, cursor: SyncCursorWrite): SyncCursor {
  assertNonEmptyString(cursor.peerId, 'sync cursor peerId');
  assertNonNegativeInteger(cursor.lastSentSeq, 'sync cursor lastSentSeq');
  assertNonNegativeInteger(cursor.lastReceivedSeq, 'sync cursor lastReceivedSeq');
  const updatedAt = cursor.updatedAt ?? Date.now();
  assertNonNegativeInteger(updatedAt, 'sync cursor updatedAt');

  db.execRun(
    `INSERT INTO sync_cursors (peer_id, last_sent_seq, last_received_seq, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(peer_id) DO UPDATE SET
       last_sent_seq = excluded.last_sent_seq,
       last_received_seq = excluded.last_received_seq,
       updated_at = excluded.updated_at`,
    [cursor.peerId, cursor.lastSentSeq, cursor.lastReceivedSeq, updatedAt],
  );

  return {
    peerId: cursor.peerId,
    lastSentSeq: cursor.lastSentSeq,
    lastReceivedSeq: cursor.lastReceivedSeq,
    updatedAt,
  };
}
