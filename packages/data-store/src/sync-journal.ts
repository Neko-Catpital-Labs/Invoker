import type { SqliteExecutor } from './sqlite-executor.js';

export const SYNC_ENTITY_TYPES = [
  'workflow',
  'task',
  'attempt',
  'event',
  // Reserved for future output-spool sync. Adapter output paths intentionally
  // do not append output journal entries yet.
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

export interface SyncCursorInput {
  peerId: string;
  lastSentSeq: number;
  lastReceivedSeq: number;
  updatedAt?: string;
}

function stringifyPayload(payload: unknown): string {
  const json = JSON.stringify(payload);
  if (json === undefined) {
    throw new Error('Sync journal payload must be JSON-serializable');
  }
  return json;
}

function mapJournalRow(row: Record<string, unknown>): SyncJournalEntry {
  const entityType = String(row.entity_type) as SyncEntityType;
  const op = String(row.op) as SyncJournalOperation;
  return {
    seq: Number(row.seq),
    entityType,
    entityId: String(row.entity_id),
    op,
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

export function appendJournalEntry(
  db: SqliteExecutor,
  entry: SyncJournalEntryInput,
): SyncJournalEntry {
  const createdAt = entry.createdAt ?? new Date().toISOString();
  const origin = entry.origin ?? 'home';
  db.execRun(
    `INSERT INTO sync_journal (entity_type, entity_id, op, payload, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      entry.entityType,
      entry.entityId,
      entry.op,
      stringifyPayload(entry.payload),
      origin,
      createdAt,
    ],
  );
  const inserted = db.queryOne('SELECT last_insert_rowid() AS seq');
  const seq = Number(inserted?.seq);
  if (!Number.isInteger(seq) || seq <= 0) {
    throw new Error('Could not read inserted sync journal sequence');
  }
  return {
    seq,
    entityType: entry.entityType,
    entityId: entry.entityId,
    op: entry.op,
    payload: entry.payload,
    origin,
    createdAt,
  };
}

export function readJournalSince(
  db: SqliteExecutor,
  seq: number,
  limit: number,
): SyncJournalEntry[] {
  const cursor = Math.max(0, Math.trunc(seq));
  const boundedLimit = Math.max(0, Math.trunc(limit));
  if (boundedLimit === 0) return [];
  const rows = db.queryAll(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [cursor, boundedLimit],
  );
  return rows.map(mapJournalRow);
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

export function setSyncCursor(db: SqliteExecutor, cursor: SyncCursorInput): SyncCursor {
  const updatedAt = cursor.updatedAt ?? new Date().toISOString();
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
