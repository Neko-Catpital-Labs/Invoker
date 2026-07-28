import type { SqliteExecutor } from './sqlite-executor.js';

// `output` is reserved for future remote sync of summarized output artifacts;
// high-volume output_spool rows are intentionally not journaled yet.
export type SyncEntityType = 'workflow' | 'task' | 'attempt' | 'event' | 'output';
export type SyncJournalOp = 'upsert' | 'tombstone';

export interface SyncJournalAppend {
  entityType: SyncEntityType;
  entityId: string;
  op: SyncJournalOp;
  payload: unknown;
  /** Local owner writes use "home"; remote ingestion can stamp its machine id later. */
  origin?: string;
  createdAt?: number;
}

export interface SyncJournalEntry {
  seq: number;
  entityType: SyncEntityType;
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

const LOCAL_ORIGIN = 'home';

function normalizeSeq(value: number, field: string): number {
  const seq = Math.trunc(value);
  if (!Number.isFinite(seq) || seq < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return seq;
}

function parsePayload(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  return JSON.parse(raw);
}

function mapJournalRow(row: Record<string, unknown>): SyncJournalEntry {
  return {
    seq: Number(row.seq),
    entityType: String(row.entity_type) as SyncEntityType,
    entityId: String(row.entity_id),
    op: String(row.op) as SyncJournalOp,
    payload: parsePayload(row.payload),
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

export function appendJournalEntry(db: SqliteExecutor, entry: SyncJournalAppend): SyncJournalEntry {
  const origin = entry.origin ?? LOCAL_ORIGIN;
  const createdAt = entry.createdAt ?? Date.now();
  const payloadValue = entry.payload === undefined ? null : entry.payload;
  const payload = JSON.stringify(payloadValue);
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
      payload,
      origin,
      createdAt,
    ],
  );
  const seq = db.getLastInsertRowid?.()
    ?? Number(db.queryOne('SELECT last_insert_rowid() AS seq')?.seq ?? 0);
  if (!Number.isInteger(seq) || seq <= 0) {
    throw new Error('Failed to read appended sync_journal seq');
  }
  return {
    seq,
    entityType: entry.entityType,
    entityId: entry.entityId,
    op: entry.op,
    payload: payloadValue,
    origin,
    createdAt,
  };
}

export function readJournalSince(db: SqliteExecutor, seq: number, limit: number): SyncJournalEntry[] {
  const sinceSeq = normalizeSeq(seq, 'seq');
  const pageLimit = Math.trunc(limit);
  if (!Number.isFinite(pageLimit) || pageLimit <= 0) return [];
  const rows = db.queryAll(
    `SELECT *
       FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [sinceSeq, pageLimit],
  );
  return rows.map((row) => mapJournalRow(row));
}

export function getSyncCursor(db: SqliteExecutor, peerId: string): SyncCursor | undefined {
  const row = db.queryOne('SELECT * FROM sync_cursors WHERE peer_id = ?', [peerId]);
  return row ? mapCursorRow(row) : undefined;
}

export function setSyncCursor(db: SqliteExecutor, cursor: SyncCursorWrite): SyncCursor {
  const lastSentSeq = normalizeSeq(cursor.lastSentSeq, 'lastSentSeq');
  const lastReceivedSeq = normalizeSeq(cursor.lastReceivedSeq, 'lastReceivedSeq');
  const updatedAt = cursor.updatedAt ?? Date.now();
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
    throw new Error(`Failed to read sync cursor for peer "${cursor.peerId}"`);
  }
  return row;
}
