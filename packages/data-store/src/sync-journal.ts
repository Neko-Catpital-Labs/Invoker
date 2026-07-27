import type { SqliteExecutor } from './sqlite-executor.js';

export type SyncJournalEntityType =
  | 'workflow'
  | 'task'
  | 'attempt'
  | 'event'
  // Reserved for output-spool sync; adapter output writes intentionally do not
  // append journal rows yet because they are high volume.
  | 'output';

export type SyncJournalOperation = 'upsert' | 'tombstone';

export interface SyncJournalEntryInput {
  entityType: SyncJournalEntityType;
  entityId: string;
  op: SyncJournalOperation;
  payload: unknown;
  origin?: string;
  createdAt?: number;
}

export interface SyncJournalRecord {
  seq: number;
  entityType: SyncJournalEntityType;
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

export interface SyncCursorInput {
  peerId: string;
  lastSentSeq: number;
  lastReceivedSeq: number;
  updatedAt?: number;
}

interface SyncJournalRow {
  seq: unknown;
  entity_type: unknown;
  entity_id: unknown;
  op: unknown;
  payload: unknown;
  origin: unknown;
  created_at: unknown;
}

interface SyncCursorRow {
  peer_id: unknown;
  last_sent_seq: unknown;
  last_received_seq: unknown;
  updated_at: unknown;
}

function requireFiniteInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${name} must be a finite integer`);
  }
  return value;
}

function toJournalRecord(row: SyncJournalRow): SyncJournalRecord {
  const payloadRaw = typeof row.payload === 'string' ? row.payload : String(row.payload ?? 'null');
  return {
    seq: Number(row.seq),
    entityType: String(row.entity_type) as SyncJournalEntityType,
    entityId: String(row.entity_id),
    op: String(row.op) as SyncJournalOperation,
    payload: JSON.parse(payloadRaw),
    origin: String(row.origin),
    createdAt: Number(row.created_at),
  };
}

function toCursor(row: SyncCursorRow): SyncCursor {
  return {
    peerId: String(row.peer_id),
    lastSentSeq: Number(row.last_sent_seq),
    lastReceivedSeq: Number(row.last_received_seq),
    updatedAt: Number(row.updated_at),
  };
}

export function appendJournalEntry(
  db: SqliteExecutor,
  entry: SyncJournalEntryInput,
): SyncJournalRecord {
  const createdAt = requireFiniteInteger(entry.createdAt ?? Date.now(), 'createdAt');
  const origin = entry.origin ?? 'home';
  const payload = JSON.stringify(entry.payload);
  if (payload === undefined) {
    throw new Error('sync journal payload must be JSON-serializable');
  }
  db.execRun(
    `INSERT INTO sync_journal (
       entity_type, entity_id, op, payload, origin, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      entry.entityType,
      entry.entityId,
      entry.op,
      payload,
      origin,
      createdAt,
    ],
  );

  const row = db.queryOne(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq = last_insert_rowid()`,
  ) as SyncJournalRow | undefined;
  if (!row) {
    throw new Error('failed to read appended sync journal row');
  }
  return toJournalRecord(row);
}

export function readJournalSince(
  db: SqliteExecutor,
  seq: number,
  limit: number,
): SyncJournalRecord[] {
  const cursor = requireFiniteInteger(Math.trunc(seq), 'seq');
  const boundedLimit = Math.max(0, requireFiniteInteger(Math.trunc(limit), 'limit'));
  if (boundedLimit === 0) return [];

  const rows = db.queryAll(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [cursor, boundedLimit],
  ) as unknown as SyncJournalRow[];
  return rows.map((row) => toJournalRecord(row));
}

export function getSyncCursor(db: SqliteExecutor, peerId: string): SyncCursor | undefined {
  const row = db.queryOne(
    `SELECT peer_id, last_sent_seq, last_received_seq, updated_at
       FROM sync_cursors
      WHERE peer_id = ?`,
    [peerId],
  ) as SyncCursorRow | undefined;
  return row ? toCursor(row) : undefined;
}

export function setSyncCursor(db: SqliteExecutor, cursor: SyncCursorInput): SyncCursor {
  const updatedAt = requireFiniteInteger(cursor.updatedAt ?? Date.now(), 'updatedAt');
  const lastSentSeq = requireFiniteInteger(cursor.lastSentSeq, 'lastSentSeq');
  const lastReceivedSeq = requireFiniteInteger(cursor.lastReceivedSeq, 'lastReceivedSeq');

  db.execRun(
    `INSERT INTO sync_cursors (
       peer_id, last_sent_seq, last_received_seq, updated_at
     ) VALUES (?, ?, ?, ?)
     ON CONFLICT(peer_id) DO UPDATE SET
       last_sent_seq = excluded.last_sent_seq,
       last_received_seq = excluded.last_received_seq,
       updated_at = excluded.updated_at`,
    [cursor.peerId, lastSentSeq, lastReceivedSeq, updatedAt],
  );

  const saved = getSyncCursor(db, cursor.peerId);
  if (!saved) {
    throw new Error(`failed to read sync cursor for peer ${cursor.peerId}`);
  }
  return saved;
}
