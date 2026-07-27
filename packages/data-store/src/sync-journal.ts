import type { SqliteExecutor } from './sqlite-executor.js';

export const LOCAL_SYNC_ORIGIN = 'home';

// `output` is reserved for future output-spool sync; current adapter hooks do
// not journal high-volume output rows.
export type SyncEntityType = 'workflow' | 'task' | 'attempt' | 'event' | 'output';
export type SyncJournalOp = 'upsert' | 'tombstone';

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

type SyncJournalDb = Pick<SqliteExecutor, 'execRun' | 'queryOne' | 'queryAll'>;

function encodePayload(payload: unknown): string {
  return JSON.stringify(payload ?? null);
}

function mapJournalRow(row: Record<string, unknown>): SyncJournalEntry {
  return {
    seq: Number(row.seq),
    entityType: String(row.entity_type) as SyncEntityType,
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
    lastSentSeq: Number(row.last_sent_seq ?? 0),
    lastReceivedSeq: Number(row.last_received_seq ?? 0),
    updatedAt: Number(row.updated_at),
  };
}

export function appendJournalEntry(db: SyncJournalDb, entry: SyncJournalEntryInput): number {
  const createdAt = entry.createdAt ?? Date.now();
  db.execRun(
    `INSERT INTO sync_journal (
      entity_type, entity_id, op, payload, origin, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      entry.entityType,
      entry.entityId,
      entry.op,
      encodePayload(entry.payload),
      entry.origin ?? LOCAL_SYNC_ORIGIN,
      createdAt,
    ],
  );
  const row = db.queryOne('SELECT last_insert_rowid() AS seq');
  return Number(row?.seq ?? 0);
}

export function readJournalSince(db: SyncJournalDb, seq: number, limit: number): SyncJournalEntry[] {
  const boundedLimit = Math.max(0, Math.trunc(limit));
  if (boundedLimit === 0) return [];
  const rows = db.queryAll(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [Math.trunc(seq), boundedLimit],
  );
  return rows.map((row) => mapJournalRow(row));
}

export function getSyncCursor(db: SyncJournalDb, peerId: string): SyncCursor | undefined {
  const row = db.queryOne(
    `SELECT peer_id, last_sent_seq, last_received_seq, updated_at
       FROM sync_cursors
      WHERE peer_id = ?`,
    [peerId],
  );
  return row ? mapCursorRow(row) : undefined;
}

export function setSyncCursor(db: SyncJournalDb, cursor: Omit<SyncCursor, 'updatedAt'> & { updatedAt?: number }): void {
  db.execRun(
    `INSERT INTO sync_cursors (
      peer_id, last_sent_seq, last_received_seq, updated_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(peer_id) DO UPDATE SET
      last_sent_seq = excluded.last_sent_seq,
      last_received_seq = excluded.last_received_seq,
      updated_at = excluded.updated_at`,
    [
      cursor.peerId,
      Math.trunc(cursor.lastSentSeq),
      Math.trunc(cursor.lastReceivedSeq),
      cursor.updatedAt ?? Date.now(),
    ],
  );
}
