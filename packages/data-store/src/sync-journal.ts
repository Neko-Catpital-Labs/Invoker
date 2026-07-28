import type { SqliteExecutor } from './sqlite-executor.js';

export const SYNC_ENTITY_TYPES = [
  'workflow',
  'task',
  'attempt',
  'event',
  // Reserved for future output snapshot/spool sync. High-volume output rows are
  // intentionally not journaled by the adapter yet.
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

export interface SyncCursorUpdate {
  peerId: string;
  lastSentSeq?: number;
  lastReceivedSeq?: number;
  updatedAt?: string;
}

function normalizeSeq(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function serializePayload(payload: unknown): string {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) {
    throw new Error('sync journal payload must be JSON-serializable');
  }
  return serialized;
}

function rowToJournalEntry(row: Record<string, unknown>): SyncJournalEntry {
  return {
    seq: Number(row.seq),
    entityType: String(row.entity_type) as SyncEntityType,
    entityId: String(row.entity_id),
    op: String(row.op) as SyncJournalOperation,
    payload: JSON.parse(String(row.payload)),
    origin: String(row.origin),
    createdAt: String(row.created_at),
  };
}

function rowToCursor(row: Record<string, unknown>): SyncCursor {
  return {
    peerId: String(row.peer_id),
    lastSentSeq: Number(row.last_sent_seq ?? 0),
    lastReceivedSeq: Number(row.last_received_seq ?? 0),
    updatedAt: String(row.updated_at),
  };
}

export function appendJournalEntry(
  db: SqliteExecutor,
  entry: SyncJournalEntryInput,
): SyncJournalEntry {
  const createdAt = entry.createdAt ?? new Date().toISOString();
  const origin = entry.origin ?? 'home';
  db.execRun(
    `INSERT INTO sync_journal (
      entity_type,
      entity_id,
      op,
      payload,
      origin,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      entry.entityType,
      entry.entityId,
      entry.op,
      serializePayload(entry.payload),
      origin,
      createdAt,
    ],
  );
  const row = db.queryOne('SELECT * FROM sync_journal WHERE seq = last_insert_rowid()');
  if (!row) {
    throw new Error('sync journal append did not return the inserted row');
  }
  return rowToJournalEntry(row);
}

export function readJournalSince(
  db: SqliteExecutor,
  seq: number,
  limit: number,
): SyncJournalEntry[] {
  const cursor = normalizeSeq(Math.trunc(seq), 'seq');
  const cappedLimit = normalizeSeq(Math.trunc(limit), 'limit');
  if (cappedLimit === 0) return [];
  const rows = db.queryAll(
    `SELECT *
       FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [cursor, cappedLimit],
  );
  return rows.map((row) => rowToJournalEntry(row));
}

export function getSyncCursor(db: SqliteExecutor, peerId: string): SyncCursor | undefined {
  const row = db.queryOne(
    'SELECT * FROM sync_cursors WHERE peer_id = ?',
    [peerId],
  );
  return row ? rowToCursor(row) : undefined;
}

export function setSyncCursor(db: SqliteExecutor, cursor: SyncCursorUpdate): SyncCursor {
  const existing = getSyncCursor(db, cursor.peerId);
  const lastSentSeq = normalizeSeq(
    cursor.lastSentSeq ?? existing?.lastSentSeq ?? 0,
    'lastSentSeq',
  );
  const lastReceivedSeq = normalizeSeq(
    cursor.lastReceivedSeq ?? existing?.lastReceivedSeq ?? 0,
    'lastReceivedSeq',
  );
  const updatedAt = cursor.updatedAt ?? new Date().toISOString();

  db.execRun(
    `INSERT INTO sync_cursors (
      peer_id,
      last_sent_seq,
      last_received_seq,
      updated_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(peer_id) DO UPDATE SET
      last_sent_seq = excluded.last_sent_seq,
      last_received_seq = excluded.last_received_seq,
      updated_at = excluded.updated_at`,
    [cursor.peerId, lastSentSeq, lastReceivedSeq, updatedAt],
  );

  const row = getSyncCursor(db, cursor.peerId);
  if (!row) {
    throw new Error(`sync cursor "${cursor.peerId}" was not persisted`);
  }
  return row;
}
