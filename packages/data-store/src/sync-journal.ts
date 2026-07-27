import type { SqliteExecutor } from './sqlite-executor.js';

export const SYNC_ENTITY_TYPES = [
  'workflow',
  'task',
  'attempt',
  'event',
  // Reserved for future output-spool sync. The adapter intentionally does not
  // journal output_spool rows yet because they are high-volume.
  'output',
] as const;

export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];
export type SyncJournalOp = 'upsert' | 'tombstone';

export interface SyncJournalAppendEntry {
  entityType: SyncEntityType;
  entityId: string;
  op: SyncJournalOp;
  payload: unknown;
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

function assertNonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

export function appendJournalEntry(db: SqliteExecutor, entry: SyncJournalAppendEntry): number {
  db.execRun(
    `INSERT INTO sync_journal (entity_type, entity_id, op, payload, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      entry.entityType,
      entry.entityId,
      entry.op,
      JSON.stringify(entry.payload),
      entry.origin ?? 'home',
      entry.createdAt ?? new Date().toISOString(),
    ],
  );
  const row = db.queryOne('SELECT last_insert_rowid() AS seq') as { seq?: number } | undefined;
  return Number(row?.seq ?? 0);
}

export function readJournalSince(db: SqliteExecutor, seq: number, limit: number): SyncJournalEntry[] {
  const normalizedSeq = Math.max(0, Math.trunc(seq));
  const normalizedLimit = Math.max(0, Math.trunc(limit));
  if (normalizedLimit === 0) return [];

  const rows = db.queryAll(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [normalizedSeq, normalizedLimit],
  ) as unknown as SyncJournalRow[];

  return rows.map((row) => ({
    seq: Number(row.seq),
    entityType: row.entity_type,
    entityId: String(row.entity_id),
    op: row.op,
    payload: JSON.parse(String(row.payload)),
    origin: String(row.origin),
    createdAt: String(row.created_at),
  }));
}

export function getSyncCursor(db: SqliteExecutor, peerId: string): SyncCursor | undefined {
  const row = db.queryOne(
    `SELECT peer_id, last_sent_seq, last_received_seq, updated_at
       FROM sync_cursors
      WHERE peer_id = ?`,
    [peerId],
  ) as unknown as SyncCursorRow | undefined;
  if (!row) return undefined;
  return {
    peerId: String(row.peer_id),
    lastSentSeq: Number(row.last_sent_seq),
    lastReceivedSeq: Number(row.last_received_seq),
    updatedAt: String(row.updated_at),
  };
}

export function setSyncCursor(db: SqliteExecutor, cursor: SyncCursorWrite): void {
  const updatedAt = cursor.updatedAt ?? new Date().toISOString();
  db.execRun(
    `INSERT INTO sync_cursors (peer_id, last_sent_seq, last_received_seq, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(peer_id) DO UPDATE SET
       last_sent_seq = excluded.last_sent_seq,
       last_received_seq = excluded.last_received_seq,
       updated_at = excluded.updated_at`,
    [
      cursor.peerId,
      assertNonNegativeInteger(cursor.lastSentSeq, 'lastSentSeq'),
      assertNonNegativeInteger(cursor.lastReceivedSeq, 'lastReceivedSeq'),
      updatedAt,
    ],
  );
}
