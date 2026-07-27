import type { SqliteExecutor } from './sqlite-executor.js';

// `output` is reserved for a future low-volume output summary/spool checkpoint
// journal entry. Raw output-spool rows are intentionally not journaled yet.
export const SYNC_ENTITY_TYPES = ['workflow', 'task', 'attempt', 'event', 'output'] as const;

export type SyncEntityType = typeof SYNC_ENTITY_TYPES[number];
export type SyncJournalOperation = 'upsert' | 'tombstone';

export interface SyncJournalEntryInput {
  entityType: SyncEntityType;
  entityId: string;
  op: SyncJournalOperation;
  payload: unknown;
  origin?: string;
  createdAt?: number;
}

export interface SyncJournalEntry {
  seq: number;
  entityType: SyncEntityType;
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

function toNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function parsePayload(payload: unknown, seq: number): unknown {
  try {
    return JSON.parse(String(payload));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid sync journal payload for seq ${seq}: ${message}`);
  }
}

export function appendJournalEntry(db: SqliteExecutor, entry: SyncJournalEntryInput): number {
  const createdAt = entry.createdAt ?? Date.now();
  toNonNegativeInteger(createdAt, 'createdAt');
  const origin = entry.origin ?? 'home';
  const payload = JSON.stringify(entry.payload);
  if (payload === undefined) {
    throw new Error('payload must be JSON-serializable');
  }
  db.execRun(
    `INSERT INTO sync_journal (entity_type, entity_id, op, payload, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [entry.entityType, entry.entityId, entry.op, payload, origin, createdAt],
  );
  const row = db.queryOne('SELECT last_insert_rowid() AS seq') as { seq?: number | bigint } | undefined;
  return Number(row?.seq ?? 0);
}

export function readJournalSince(
  db: SqliteExecutor,
  seq: number,
  limit: number,
): SyncJournalEntry[] {
  const cursor = toNonNegativeInteger(seq, 'seq');
  const cappedLimit = toNonNegativeInteger(limit, 'limit');
  if (cappedLimit === 0) return [];

  const rows = db.queryAll(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [cursor, cappedLimit],
  );

  return rows.map((row) => {
    const rowSeq = Number(row.seq);
    return {
      seq: rowSeq,
      entityType: String(row.entity_type) as SyncEntityType,
      entityId: String(row.entity_id),
      op: String(row.op) as SyncJournalOperation,
      payload: parsePayload(row.payload, rowSeq),
      origin: String(row.origin),
      createdAt: Number(row.created_at),
    };
  });
}

export function getSyncCursor(db: SqliteExecutor, peerId: string): SyncCursor | undefined {
  const row = db.queryOne(
    `SELECT peer_id, last_sent_seq, last_received_seq, updated_at
       FROM sync_cursors
      WHERE peer_id = ?`,
    [peerId],
  );
  if (!row) return undefined;
  return {
    peerId: String(row.peer_id),
    lastSentSeq: Number(row.last_sent_seq),
    lastReceivedSeq: Number(row.last_received_seq),
    updatedAt: Number(row.updated_at),
  };
}

export function setSyncCursor(db: SqliteExecutor, cursor: SyncCursorInput): SyncCursor {
  const lastSentSeq = toNonNegativeInteger(cursor.lastSentSeq, 'lastSentSeq');
  const lastReceivedSeq = toNonNegativeInteger(cursor.lastReceivedSeq, 'lastReceivedSeq');
  const updatedAt = toNonNegativeInteger(cursor.updatedAt ?? Date.now(), 'updatedAt');
  db.execRun(
    `INSERT INTO sync_cursors (peer_id, last_sent_seq, last_received_seq, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(peer_id) DO UPDATE SET
       last_sent_seq = excluded.last_sent_seq,
       last_received_seq = excluded.last_received_seq,
       updated_at = excluded.updated_at`,
    [cursor.peerId, lastSentSeq, lastReceivedSeq, updatedAt],
  );
  return {
    peerId: cursor.peerId,
    lastSentSeq,
    lastReceivedSeq,
    updatedAt,
  };
}
