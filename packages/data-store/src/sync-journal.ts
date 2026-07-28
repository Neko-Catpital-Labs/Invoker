import type { SqliteExecutor } from './sqlite-executor.js';

export const SYNC_ENTITY_TYPES = [
  'workflow',
  'task',
  'attempt',
  'event',
  // Reserved for future output-spool sync. High-volume output rows are not
  // journaled until transport/backpressure rules exist.
  'output',
] as const;

export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];
export type SyncJournalOp = 'upsert' | 'tombstone';

export interface SyncJournalEntryInput {
  entityType: SyncEntityType;
  entityId: string;
  op: SyncJournalOp;
  payload: unknown;
  /** Machine id of the writer. Local owner-process writes use `home`. */
  origin?: string;
  /** Milliseconds since epoch. Defaults to Date.now(). */
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
  /** Milliseconds since epoch. Defaults to Date.now(). */
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

function toNonNegativeInteger(value: unknown, field: string): number {
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`Invalid sync ${field}: ${String(value)}`);
  }
  return n;
}

function stringifyPayload(payload: unknown): string {
  const json = JSON.stringify(payload);
  if (json === undefined) {
    throw new Error('Sync journal payload must be JSON-serializable');
  }
  return json;
}

function mapJournalRow(row: SyncJournalRow): SyncJournalEntry {
  return {
    seq: toNonNegativeInteger(row.seq, 'journal seq'),
    entityType: String(row.entity_type) as SyncEntityType,
    entityId: String(row.entity_id),
    op: String(row.op) as SyncJournalOp,
    payload: JSON.parse(String(row.payload)),
    origin: String(row.origin),
    createdAt: toNonNegativeInteger(row.created_at, 'journal created_at'),
  };
}

function mapCursorRow(row: SyncCursorRow): SyncCursor {
  return {
    peerId: String(row.peer_id),
    lastSentSeq: toNonNegativeInteger(row.last_sent_seq, 'cursor last_sent_seq'),
    lastReceivedSeq: toNonNegativeInteger(row.last_received_seq, 'cursor last_received_seq'),
    updatedAt: toNonNegativeInteger(row.updated_at, 'cursor updated_at'),
  };
}

export function appendJournalEntry(
  db: SqliteExecutor,
  entry: SyncJournalEntryInput,
): SyncJournalEntry {
  const createdAt = entry.createdAt ?? Date.now();
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
      stringifyPayload(entry.payload),
      entry.origin ?? 'home',
      createdAt,
    ],
  );

  const row = db.queryOne(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq = last_insert_rowid()`,
  ) as SyncJournalRow | undefined;
  if (!row) {
    throw new Error('Failed to read appended sync journal row');
  }
  return mapJournalRow(row);
}

export function readJournalSince(
  db: SqliteExecutor,
  seq: number,
  limit: number,
): SyncJournalEntry[] {
  const cursor = toNonNegativeInteger(seq, 'journal cursor');
  const cappedLimit = Math.max(0, Math.trunc(limit));
  if (cappedLimit === 0) return [];

  const rows = db.queryAll(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [cursor, cappedLimit],
  ) as unknown as SyncJournalRow[];
  return rows.map((row) => mapJournalRow(row));
}

export function getSyncCursor(db: SqliteExecutor, peerId: string): SyncCursor | undefined {
  const row = db.queryOne(
    `SELECT peer_id, last_sent_seq, last_received_seq, updated_at
       FROM sync_cursors
      WHERE peer_id = ?`,
    [peerId],
  ) as SyncCursorRow | undefined;
  return row ? mapCursorRow(row) : undefined;
}

export function setSyncCursor(db: SqliteExecutor, cursor: SyncCursorWrite): SyncCursor {
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
    [cursor.peerId, cursor.lastSentSeq, cursor.lastReceivedSeq, updatedAt],
  );
  const saved = getSyncCursor(db, cursor.peerId);
  if (!saved) {
    throw new Error(`Failed to read sync cursor for peer ${cursor.peerId}`);
  }
  return saved;
}
