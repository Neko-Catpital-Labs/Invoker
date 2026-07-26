import type { SqliteExecutor } from './sqlite-executor.js';

// `output` is reserved for future low-volume output snapshots. The
// high-volume output spool is intentionally not journaled yet.
export const SYNC_JOURNAL_ENTITY_TYPES = [
  'workflow',
  'task',
  'attempt',
  'event',
  'output',
] as const;

export type SyncJournalEntityType = typeof SYNC_JOURNAL_ENTITY_TYPES[number];
export type SyncJournalOp = 'upsert' | 'tombstone';

export interface AppendSyncJournalEntry {
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

export interface SetSyncCursorInput {
  peerId: string;
  lastSentSeq: number;
  lastReceivedSeq: number;
  updatedAt?: number;
}

function assertJsonPayload(payload: unknown): string {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) {
    throw new Error('sync journal payload must be JSON serializable');
  }
  return serialized;
}

function mapJournalRow(row: Record<string, unknown>): SyncJournalEntry {
  return {
    seq: Number(row.seq),
    entityType: String(row.entity_type) as SyncJournalEntityType,
    entityId: String(row.entity_id),
    op: String(row.op) as SyncJournalOp,
    payload: JSON.parse(String(row.payload)),
    origin: String(row.origin),
    createdAt: Number(row.created_at),
  };
}

function mapCursorRow(row: Record<string, unknown>): SyncCursor {
  return {
    peerId: String(row.peer_id),
    lastSentSeq: Number(row.last_sent_seq),
    lastReceivedSeq: Number(row.last_received_seq),
    updatedAt: Number(row.updated_at),
  };
}

export function appendJournalEntry(
  db: SqliteExecutor,
  entry: AppendSyncJournalEntry,
): SyncJournalEntry {
  const createdAt = entry.createdAt ?? Date.now();
  const origin = entry.origin ?? 'home';
  const payload = assertJsonPayload(entry.payload);
  const storedPayload = JSON.parse(payload);

  db.execRun(
    `INSERT INTO sync_journal (entity_type, entity_id, op, payload, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [entry.entityType, entry.entityId, entry.op, payload, origin, createdAt],
  );

  const row = db.queryOne('SELECT last_insert_rowid() AS seq');
  const seq = Number(row?.seq);
  return {
    seq,
    entityType: entry.entityType,
    entityId: entry.entityId,
    op: entry.op,
    payload: storedPayload,
    origin,
    createdAt,
  };
}

export function readJournalSince(
  db: SqliteExecutor,
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
  return rows.map((row) => mapJournalRow(row));
}

export function getSyncCursor(db: SqliteExecutor, peerId: string): SyncCursor | undefined {
  const row = db.queryOne(
    `SELECT peer_id, last_sent_seq, last_received_seq, updated_at
       FROM sync_cursors
      WHERE peer_id = ?`,
    [peerId],
  );
  return row ? mapCursorRow(row) : undefined;
}

export function setSyncCursor(db: SqliteExecutor, cursor: SetSyncCursorInput): SyncCursor {
  const updatedAt = cursor.updatedAt ?? Date.now();
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
