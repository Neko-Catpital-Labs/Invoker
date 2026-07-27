import type { SqliteExecutor } from './sqlite-executor.js';

// `output` is reserved for future output-spool sync. The adapter deliberately
// does not journal high-volume output rows yet.
export type SyncEntityType = 'workflow' | 'task' | 'attempt' | 'event' | 'output';
export type SyncJournalOp = 'upsert' | 'tombstone';

export interface SyncJournalEntryInput {
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

export type SyncJournalDatabase = Pick<SqliteExecutor, 'execRun' | 'queryOne' | 'queryAll'>;

const LOCAL_JOURNAL_ORIGIN = 'home';

function encodePayload(payload: unknown): string {
  return JSON.stringify(payload ?? null);
}

function mapJournalRow(row: Record<string, unknown>): SyncJournalEntry {
  return {
    seq: Number(row.seq),
    entityType: row.entity_type as SyncEntityType,
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
    lastSentSeq: Number(row.last_sent_seq ?? 0),
    lastReceivedSeq: Number(row.last_received_seq ?? 0),
    updatedAt: String(row.updated_at),
  };
}

export function appendJournalEntry(
  db: SyncJournalDatabase,
  entry: SyncJournalEntryInput,
): SyncJournalEntry {
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
      encodePayload(entry.payload),
      entry.origin ?? LOCAL_JOURNAL_ORIGIN,
      entry.createdAt ?? new Date().toISOString(),
    ],
  );
  const row = db.queryOne('SELECT * FROM sync_journal WHERE seq = last_insert_rowid()');
  if (!row) {
    throw new Error('sync_journal insert did not return a row');
  }
  return mapJournalRow(row);
}

export function readJournalSince(
  db: SyncJournalDatabase,
  seq: number,
  limit: number,
): SyncJournalEntry[] {
  const safeSeq = Math.max(0, Math.trunc(seq));
  const safeLimit = Math.max(0, Math.trunc(limit));
  if (safeLimit === 0) return [];
  const rows = db.queryAll(
    `SELECT * FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [safeSeq, safeLimit],
  );
  return rows.map((row) => mapJournalRow(row));
}

export function getSyncCursor(
  db: SyncJournalDatabase,
  peerId: string,
): SyncCursor | undefined {
  const row = db.queryOne('SELECT * FROM sync_cursors WHERE peer_id = ?', [peerId]);
  return row ? mapCursorRow(row) : undefined;
}

export function setSyncCursor(db: SyncJournalDatabase, cursor: SyncCursorWrite): SyncCursor;
export function setSyncCursor(
  db: SyncJournalDatabase,
  peerId: string,
  cursor: Omit<SyncCursorWrite, 'peerId'>,
): SyncCursor;
export function setSyncCursor(
  db: SyncJournalDatabase,
  peerOrCursor: string | SyncCursorWrite,
  cursor?: Omit<SyncCursorWrite, 'peerId'>,
): SyncCursor {
  const next: SyncCursorWrite = typeof peerOrCursor === 'string'
    ? {
        peerId: peerOrCursor,
        lastSentSeq: cursor?.lastSentSeq ?? 0,
        lastReceivedSeq: cursor?.lastReceivedSeq ?? 0,
        updatedAt: cursor?.updatedAt,
      }
    : peerOrCursor;
  if (!next.peerId) {
    throw new Error('sync cursor peerId is required');
  }
  const updatedAt = next.updatedAt ?? new Date().toISOString();
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
      next.peerId,
      Math.max(0, Math.trunc(next.lastSentSeq)),
      Math.max(0, Math.trunc(next.lastReceivedSeq)),
      updatedAt,
    ],
  );
  const saved = getSyncCursor(db, next.peerId);
  if (!saved) {
    throw new Error(`sync cursor "${next.peerId}" was not saved`);
  }
  return saved;
}
