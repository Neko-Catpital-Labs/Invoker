import type { SqliteExecutor } from './sqlite-executor.js';

export type SyncEntityType = 'workflow' | 'task' | 'attempt' | 'event' | 'output';
export type SyncJournalOp = 'upsert' | 'tombstone';

export const LOCAL_SYNC_ORIGIN = 'home';

export interface SyncJournalEntryInput {
  entityType: SyncEntityType;
  entityId: string;
  op: SyncJournalOp;
  payload: unknown;
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

export interface SyncCursorInput {
  peerId: string;
  lastSentSeq: number;
  lastReceivedSeq: number;
  updatedAt?: number;
}

type SyncJournalRow = {
  seq: number;
  entity_type: string;
  entity_id: string;
  op: string;
  payload: string;
  origin: string;
  created_at: number;
};

type SyncCursorRow = {
  peer_id: string;
  last_sent_seq: number;
  last_received_seq: number;
  updated_at: number;
};

/**
 * `output` is reserved in the entity enum for future output snapshot journaling.
 * High-volume output spool rows intentionally do not append sync journal rows yet.
 */
export function appendJournalEntry(db: SqliteExecutor, entry: SyncJournalEntryInput): SyncJournalEntry {
  const payloadJson = JSON.stringify(entry.payload);
  if (payloadJson === undefined) {
    throw new Error(`Sync journal payload for ${entry.entityType}:${entry.entityId} is not JSON-serializable`);
  }

  const createdAt = entry.createdAt ?? Date.now();
  const origin = entry.origin ?? LOCAL_SYNC_ORIGIN;
  db.execRun(
    `INSERT INTO sync_journal (entity_type, entity_id, op, payload, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [entry.entityType, entry.entityId, entry.op, payloadJson, origin, createdAt],
  );

  const row = db.queryOne('SELECT last_insert_rowid() AS seq') as { seq?: number } | undefined;
  const seq = Number(row?.seq ?? 0);
  if (!Number.isInteger(seq) || seq <= 0) {
    throw new Error('Sync journal append succeeded but inserted seq could not be read back');
  }
  return {
    seq,
    entityType: entry.entityType,
    entityId: entry.entityId,
    op: entry.op,
    payload: JSON.parse(payloadJson),
    origin,
    createdAt,
  };
}

export function readJournalSince(db: SqliteExecutor, seq: number, limit: number): SyncJournalEntry[] {
  const cappedLimit = Math.max(0, Math.trunc(limit));
  if (cappedLimit === 0) return [];

  const rows = db.queryAll(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [Math.max(0, Math.trunc(seq)), cappedLimit],
  ) as SyncJournalRow[];
  return rows.map(mapJournalRow);
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

export function setSyncCursor(db: SqliteExecutor, cursor: SyncCursorInput): SyncCursor {
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

  const saved = getSyncCursor(db, cursor.peerId);
  if (!saved) {
    throw new Error(`Sync cursor for peer "${cursor.peerId}" could not be read after upsert`);
  }
  return saved;
}

function mapJournalRow(row: SyncJournalRow): SyncJournalEntry {
  return {
    seq: Number(row.seq),
    entityType: row.entity_type as SyncEntityType,
    entityId: row.entity_id,
    op: row.op as SyncJournalOp,
    payload: JSON.parse(row.payload),
    origin: row.origin,
    createdAt: Number(row.created_at),
  };
}

function mapCursorRow(row: SyncCursorRow): SyncCursor {
  return {
    peerId: row.peer_id,
    lastSentSeq: Number(row.last_sent_seq),
    lastReceivedSeq: Number(row.last_received_seq),
    updatedAt: Number(row.updated_at),
  };
}
