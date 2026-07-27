import type { SqliteExecutor } from './sqlite-executor.js';

export const SYNC_JOURNAL_ENTITY_TYPES = [
  'workflow',
  'task',
  'attempt',
  'event',
  // Reserved for output sync metadata. High-volume output spool rows are not
  // journaled until the transport/compaction design exists.
  'output',
] as const;

export type SyncJournalEntityType = (typeof SYNC_JOURNAL_ENTITY_TYPES)[number];
export type SyncJournalOperation = 'upsert' | 'tombstone';

export interface SyncJournalEntryInput {
  entityType: SyncJournalEntityType;
  entityId: string;
  op: SyncJournalOperation;
  payload: unknown;
  origin?: string;
  createdAt?: string;
}

export interface SyncJournalEntry {
  seq: number;
  entityType: SyncJournalEntityType;
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

export interface SyncCursorInput {
  peerId: string;
  lastSentSeq: number;
  lastReceivedSeq: number;
  updatedAt?: string;
}

type SyncJournalDb = Pick<SqliteExecutor, 'execRun' | 'queryAll' | 'queryOne'>;

export function appendJournalEntry(db: SyncJournalDb, entry: SyncJournalEntryInput): void {
  const payloadJson = JSON.stringify(entry.payload);
  if (payloadJson === undefined) {
    throw new Error('sync journal payload must be JSON-serializable');
  }
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
      payloadJson,
      entry.origin ?? 'home',
      entry.createdAt ?? new Date().toISOString(),
    ],
  );
}

export function readJournalSince(
  db: Pick<SqliteExecutor, 'queryAll'>,
  seq: number,
  limit: number,
): SyncJournalEntry[] {
  const boundedLimit = Math.max(0, Math.trunc(limit));
  if (boundedLimit === 0) return [];
  const rows = db.queryAll(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [Math.max(0, Math.trunc(seq)), boundedLimit],
  );
  return rows.map(mapJournalRow);
}

export function getSyncCursor(
  db: Pick<SqliteExecutor, 'queryOne'>,
  peerId: string,
): SyncCursor | undefined {
  const row = db.queryOne(
    `SELECT peer_id, last_sent_seq, last_received_seq, updated_at
       FROM sync_cursors
      WHERE peer_id = ?`,
    [peerId],
  );
  return row ? mapCursorRow(row) : undefined;
}

export function setSyncCursor(db: Pick<SqliteExecutor, 'execRun'>, cursor: SyncCursorInput): void {
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
    [
      cursor.peerId,
      cursor.lastSentSeq,
      cursor.lastReceivedSeq,
      cursor.updatedAt ?? new Date().toISOString(),
    ],
  );
}

function mapJournalRow(row: Record<string, unknown>): SyncJournalEntry {
  return {
    seq: Number(row.seq),
    entityType: String(row.entity_type) as SyncJournalEntityType,
    entityId: String(row.entity_id),
    op: String(row.op) as SyncJournalOperation,
    payload: JSON.parse(String(row.payload)),
    origin: String(row.origin),
    createdAt: String(row.created_at),
  };
}

function mapCursorRow(row: Record<string, unknown>): SyncCursor {
  return {
    peerId: String(row.peer_id),
    lastSentSeq: Number(row.last_sent_seq),
    lastReceivedSeq: Number(row.last_received_seq),
    updatedAt: String(row.updated_at),
  };
}
