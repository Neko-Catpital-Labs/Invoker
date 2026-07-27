import type { SqliteExecutor } from './sqlite-executor.js';

export type SyncJournalEntityType =
  | 'workflow'
  | 'task'
  | 'attempt'
  | 'event'
  // Reserved for output sync metadata; output spool rows are intentionally not journaled yet.
  | 'output';

export type SyncJournalOp = 'upsert' | 'tombstone';

export interface SyncJournalEntryInput {
  entityType: SyncJournalEntityType;
  entityId: string;
  op: SyncJournalOp;
  payload: unknown;
  origin?: string;
  createdAt?: string;
}

export interface SyncJournalEntry {
  seq: number;
  entityType: SyncJournalEntityType;
  entityId: string;
  op: SyncJournalOp;
  payload: unknown;
  origin: string;
  createdAt: string;
}

export interface SyncCursorInput {
  peerId: string;
  lastSentSeq: number;
  lastReceivedSeq: number;
  updatedAt?: string;
}

export interface SyncCursor {
  peerId: string;
  lastSentSeq: number;
  lastReceivedSeq: number;
  updatedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function mapJournalRow(row: Record<string, unknown>): SyncJournalEntry {
  return {
    seq: Number(row.seq),
    entityType: row.entity_type as SyncJournalEntityType,
    entityId: String(row.entity_id),
    op: row.op as SyncJournalOp,
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
  const origin = entry.origin ?? 'home';
  const createdAt = entry.createdAt ?? nowIso();
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
      JSON.stringify(entry.payload ?? null),
      origin,
      createdAt,
    ],
  );

  const row = db.queryOne('SELECT * FROM sync_journal WHERE seq = last_insert_rowid()');
  if (!row) {
    throw new Error('appendJournalEntry failed to read inserted sync_journal row');
  }
  return mapJournalRow(row);
}

export function readJournalSince(
  db: SqliteExecutor,
  seq: number,
  limit: number,
): SyncJournalEntry[] {
  const cursor = Math.max(0, Math.trunc(seq));
  const pageLimit = Math.max(0, Math.trunc(limit));
  if (pageLimit === 0) return [];
  const rows = db.queryAll(
    `SELECT *
       FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [cursor, pageLimit],
  );
  return rows.map(mapJournalRow);
}

export function getSyncCursor(db: SqliteExecutor, peerId: string): SyncCursor | undefined {
  const row = db.queryOne('SELECT * FROM sync_cursors WHERE peer_id = ?', [peerId]);
  return row ? mapCursorRow(row) : undefined;
}

export function setSyncCursor(db: SqliteExecutor, cursor: SyncCursorInput): SyncCursor {
  const updatedAt = cursor.updatedAt ?? nowIso();
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
    throw new Error(`setSyncCursor failed to read peer ${cursor.peerId}`);
  }
  return saved;
}
