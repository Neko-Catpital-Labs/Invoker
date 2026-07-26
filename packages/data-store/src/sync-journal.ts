import type { SqliteExecutor } from './sqlite-executor.js';

export const SYNC_ENTITY_TYPES = [
  'workflow',
  'task',
  'attempt',
  'event',
  // Reserved for future output-spool sync. Output rows are intentionally not
  // journaled yet because they are high-volume and need separate batching.
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

export interface SyncCursorWrite {
  peerId: string;
  lastSentSeq: number;
  lastReceivedSeq: number;
  updatedAt?: number;
}

function assertNonEmptyString(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function parsePayload(raw: unknown, seq: number): unknown {
  try {
    return JSON.parse(String(raw));
  } catch (err) {
    throw new Error(
      `Invalid sync_journal payload JSON for seq ${seq}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function rowToJournalEntry(row: Record<string, unknown>): SyncJournalEntry {
  const seq = Number(row.seq);
  return {
    seq,
    entityType: String(row.entity_type) as SyncEntityType,
    entityId: String(row.entity_id),
    op: String(row.op) as SyncJournalOperation,
    payload: parsePayload(row.payload, seq),
    origin: String(row.origin),
    createdAt: Number(row.created_at),
  };
}

function rowToCursor(row: Record<string, unknown>): SyncCursor {
  return {
    peerId: String(row.peer_id),
    lastSentSeq: Number(row.last_sent_seq ?? 0),
    lastReceivedSeq: Number(row.last_received_seq ?? 0),
    updatedAt: Number(row.updated_at),
  };
}

export function appendJournalEntry(db: SqliteExecutor, entry: SyncJournalEntryInput): number {
  assertNonEmptyString(entry.entityId, 'entityId');
  const origin = entry.origin ?? 'home';
  assertNonEmptyString(origin, 'origin');
  const payload = JSON.stringify(entry.payload ?? null);
  if (payload === undefined) {
    throw new Error(`sync_journal payload for ${entry.entityType}:${entry.entityId} is not JSON-serializable`);
  }

  db.execRun(
    `INSERT INTO sync_journal (entity_type, entity_id, op, payload, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      entry.entityType,
      entry.entityId,
      entry.op,
      payload,
      origin,
      entry.createdAt ?? Date.now(),
    ],
  );

  const row = db.queryOne('SELECT last_insert_rowid() AS seq') as { seq?: unknown } | undefined;
  return Number(row?.seq ?? 0);
}

export function readJournalSince(
  db: SqliteExecutor,
  seq: number,
  limit: number,
): SyncJournalEntry[] {
  const pageLimit = Math.max(0, Math.floor(limit));
  if (pageLimit === 0) return [];
  const rows = db.queryAll(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [Math.max(0, Math.floor(seq)), pageLimit],
  );
  return rows.map((row) => rowToJournalEntry(row));
}

export function getSyncCursor(db: SqliteExecutor, peerId: string): SyncCursor | undefined {
  assertNonEmptyString(peerId, 'peerId');
  const row = db.queryOne(
    `SELECT peer_id, last_sent_seq, last_received_seq, updated_at
       FROM sync_cursors
      WHERE peer_id = ?`,
    [peerId],
  );
  return row ? rowToCursor(row) : undefined;
}

export function setSyncCursor(db: SqliteExecutor, cursor: SyncCursorWrite): SyncCursor {
  assertNonEmptyString(cursor.peerId, 'peerId');
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
