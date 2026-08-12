import type { SqliteExecutor } from './sqlite-executor.js';

export const LOCAL_SYNC_ORIGIN = 'home';

export const SYNC_ENTITY_TYPES = [
  'workflow',
  'task',
  'attempt',
  'event',
  // Reserved for future output sync. output_spool rows are intentionally not
  // journaled yet because they are high-volume streaming data.
  'output',
] as const;

export type SyncEntityType = typeof SYNC_ENTITY_TYPES[number];
export type SyncJournalOp = 'upsert' | 'tombstone';

export interface SyncJournalEntryInput {
  entityType?: SyncEntityType;
  entityId?: string;
  entity_type?: SyncEntityType;
  entity_id?: string;
  op: SyncJournalOp;
  payload: unknown;
  origin?: string;
  createdAt?: string;
  created_at?: string;
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

export interface SyncCursorUpdate {
  peerId?: string;
  lastSentSeq?: number;
  lastReceivedSeq?: number;
  updatedAt?: string;
  peer_id?: string;
  last_sent_seq?: number;
  last_received_seq?: number;
  updated_at?: string;
}

function asNonNegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function mapJournalRow(row: Record<string, unknown>): SyncJournalEntry {
  return {
    seq: Number(row.seq),
    entityType: String(row.entity_type) as SyncEntityType,
    entityId: String(row.entity_id),
    op: String(row.op) as SyncJournalOp,
    payload: JSON.parse(String(row.payload ?? 'null')),
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
  db: SqliteExecutor,
  entry: SyncJournalEntryInput,
): SyncJournalEntry {
  const entityType = entry.entityType ?? entry.entity_type;
  const entityId = entry.entityId ?? entry.entity_id;
  if (!entityType) throw new Error('sync journal entry requires entityType');
  if (!entityId) throw new Error('sync journal entry requires entityId');
  const createdAt = entry.createdAt ?? entry.created_at ?? new Date().toISOString();
  const origin = entry.origin ?? LOCAL_SYNC_ORIGIN;
  const payload = JSON.stringify(entry.payload ?? null);

  db.execRun(
    `INSERT INTO sync_journal (entity_type, entity_id, op, payload, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [entityType, entityId, entry.op, payload, origin, createdAt],
  );

  const inserted = db.queryOne('SELECT last_insert_rowid() AS seq') as { seq?: number } | undefined;
  const seq = Number(inserted?.seq);
  if (!Number.isFinite(seq) || seq <= 0) {
    throw new Error('Failed to read sync journal row id after insert');
  }
  return {
    seq,
    entityType,
    entityId,
    op: entry.op,
    payload: entry.payload ?? null,
    origin,
    createdAt,
  };
}

export function readJournalSince(
  db: SqliteExecutor,
  seq: number,
  limit = 100,
): SyncJournalEntry[] {
  const cursor = asNonNegativeInteger('seq', Math.trunc(seq));
  const cappedLimit = asNonNegativeInteger('limit', Math.trunc(limit));
  if (cappedLimit === 0) return [];

  const rows = db.queryAll(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [cursor, cappedLimit],
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

export function setSyncCursor(db: SqliteExecutor, cursor: SyncCursorUpdate): SyncCursor;
export function setSyncCursor(
  db: SqliteExecutor,
  peerId: string,
  lastSentSeq: number,
  lastReceivedSeq: number,
  updatedAt?: string,
): SyncCursor;
export function setSyncCursor(
  db: SqliteExecutor,
  cursorOrPeerId: SyncCursorUpdate | string,
  lastSentSeqArg?: number,
  lastReceivedSeqArg?: number,
  updatedAtArg?: string,
): SyncCursor {
  const cursor = typeof cursorOrPeerId === 'string'
    ? {
        peerId: cursorOrPeerId,
        lastSentSeq: lastSentSeqArg,
        lastReceivedSeq: lastReceivedSeqArg,
        updatedAt: updatedAtArg,
      }
    : cursorOrPeerId;
  const peerId = cursor.peerId ?? cursor.peer_id;
  if (!peerId) throw new Error('sync cursor requires peerId');
  const existing = getSyncCursor(db, peerId);
  const lastSentSeq = asNonNegativeInteger(
    'lastSentSeq',
    Math.trunc(cursor.lastSentSeq ?? cursor.last_sent_seq ?? existing?.lastSentSeq ?? 0),
  );
  const lastReceivedSeq = asNonNegativeInteger(
    'lastReceivedSeq',
    Math.trunc(cursor.lastReceivedSeq ?? cursor.last_received_seq ?? existing?.lastReceivedSeq ?? 0),
  );
  const updatedAt = cursor.updatedAt ?? cursor.updated_at ?? new Date().toISOString();

  db.execRun(
    `INSERT INTO sync_cursors (peer_id, last_sent_seq, last_received_seq, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(peer_id) DO UPDATE SET
       last_sent_seq = excluded.last_sent_seq,
       last_received_seq = excluded.last_received_seq,
       updated_at = excluded.updated_at`,
    [peerId, lastSentSeq, lastReceivedSeq, updatedAt],
  );

  const saved = getSyncCursor(db, peerId);
  if (!saved) {
    throw new Error(`Failed to load sync cursor for peer ${peerId} after upsert`);
  }
  return saved;
}

export const getCursor = getSyncCursor;
export const setCursor = setSyncCursor;
