import type { SqliteExecutor } from './sqlite-executor.js';

export const SYNC_ENTITY_TYPES = [
  'workflow',
  'task',
  'attempt',
  'event',
  // Reserved for future output-spool sync. Current output write paths do not journal.
  'output',
] as const;

export type SyncEntityType = typeof SYNC_ENTITY_TYPES[number];
export type SyncJournalOp = 'upsert' | 'tombstone';

export interface AppendJournalEntryInput {
  entityType: SyncEntityType;
  entityId: string;
  op: SyncJournalOp;
  payload: unknown;
  /** Local writes originate at the home machine until remote transport exists. */
  origin?: string;
  createdAt?: string;
}

export interface SyncJournalEntry {
  seq: number;
  entityType: SyncEntityType;
  entityId: string;
  op: SyncJournalOp;
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
  lastSentSeq: number;
  lastReceivedSeq: number;
  updatedAt?: string;
}

interface SyncJournalRow {
  seq: number;
  entity_type: SyncEntityType;
  entity_id: string;
  op: SyncJournalOp;
  payload: string;
  origin: string;
  created_at: string;
}

interface SyncCursorRow {
  peer_id: string;
  last_sent_seq: number;
  last_received_seq: number;
  updated_at: string;
}

function stringifyPayload(payload: unknown): string {
  const json = JSON.stringify(payload);
  if (json === undefined) {
    throw new Error('sync journal payload must be JSON-serializable');
  }
  return json;
}

function mapJournalRow(row: SyncJournalRow): SyncJournalEntry {
  return {
    seq: Number(row.seq),
    entityType: row.entity_type,
    entityId: String(row.entity_id),
    op: row.op,
    payload: JSON.parse(row.payload),
    origin: String(row.origin),
    createdAt: String(row.created_at),
  };
}

function mapCursorRow(row: SyncCursorRow): SyncCursor {
  return {
    peerId: String(row.peer_id),
    lastSentSeq: Number(row.last_sent_seq),
    lastReceivedSeq: Number(row.last_received_seq),
    updatedAt: String(row.updated_at),
  };
}

export function appendJournalEntry(
  db: SqliteExecutor,
  entry: AppendJournalEntryInput,
): SyncJournalEntry {
  const createdAt = entry.createdAt ?? new Date().toISOString();
  db.execRun(
    `INSERT INTO sync_journal (
       entity_type, entity_id, op, payload, origin, created_at
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
    throw new Error('sync journal append did not return an inserted row');
  }
  return mapJournalRow(row);
}

export function readJournalSince(
  db: SqliteExecutor,
  seq: number,
  limit: number,
): SyncJournalEntry[] {
  const normalizedLimit = Math.max(0, Math.trunc(limit));
  if (normalizedLimit === 0) return [];
  const rows = db.queryAll(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [Math.trunc(seq), normalizedLimit],
  ) as unknown as SyncJournalRow[];
  return rows.map(mapJournalRow);
}

export function getSyncCursor(
  db: SqliteExecutor,
  peerId: string,
): SyncCursor | undefined {
  const row = db.queryOne(
    `SELECT peer_id, last_sent_seq, last_received_seq, updated_at
       FROM sync_cursors
      WHERE peer_id = ?`,
    [peerId],
  ) as SyncCursorRow | undefined;
  return row ? mapCursorRow(row) : undefined;
}

export function setSyncCursor(
  db: SqliteExecutor,
  cursor: SyncCursorWrite,
): SyncCursor {
  const updatedAt = cursor.updatedAt ?? new Date().toISOString();
  db.execRun(
    `INSERT INTO sync_cursors (
       peer_id, last_sent_seq, last_received_seq, updated_at
     ) VALUES (?, ?, ?, ?)
     ON CONFLICT(peer_id) DO UPDATE SET
       last_sent_seq = excluded.last_sent_seq,
       last_received_seq = excluded.last_received_seq,
       updated_at = excluded.updated_at`,
    [cursor.peerId, cursor.lastSentSeq, cursor.lastReceivedSeq, updatedAt],
  );
  const saved = getSyncCursor(db, cursor.peerId);
  if (!saved) {
    throw new Error(`sync cursor ${cursor.peerId} was not saved`);
  }
  return saved;
}
