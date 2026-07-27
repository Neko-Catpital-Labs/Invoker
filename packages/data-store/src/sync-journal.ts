import type { SqliteExecutor } from './sqlite-executor.js';

export type SyncJournalEntityType =
  | 'workflow'
  | 'task'
  | 'attempt'
  | 'event'
  // Reserved for future output-spool sync. Adapter output writes are not journaled yet.
  | 'output';

export type SyncJournalOperation = 'upsert' | 'tombstone';

export interface SyncJournalAppendEntry {
  entityType: SyncJournalEntityType;
  entityId: string;
  op: SyncJournalOperation;
  payload: unknown;
  origin?: string;
  createdAt?: string;
}

export interface SyncJournalEntry {
  seq: number;
  entityType: SyncJournalEntityType;
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

export interface SyncCursorPatch {
  peerId: string;
  lastSentSeq?: number;
  lastReceivedSeq?: number;
  updatedAt?: string;
}

const ENTITY_TYPES = new Set<SyncJournalEntityType>([
  'workflow',
  'task',
  'attempt',
  'event',
  'output',
]);

const OPERATIONS = new Set<SyncJournalOperation>(['upsert', 'tombstone']);

function assertEntityType(value: SyncJournalEntityType): void {
  if (!ENTITY_TYPES.has(value)) {
    throw new Error(`Invalid sync journal entity_type: ${String(value)}`);
  }
}

function assertOperation(value: SyncJournalOperation): void {
  if (!OPERATIONS.has(value)) {
    throw new Error(`Invalid sync journal op: ${String(value)}`);
  }
}

function normalizeSeq(value: number, name: string): number {
  const seq = Math.trunc(value);
  if (!Number.isFinite(seq) || seq < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return seq;
}

function mapJournalRow(row: Record<string, unknown>): SyncJournalEntry {
  return {
    seq: Number(row.seq),
    entityType: String(row.entity_type) as SyncJournalEntityType,
    entityId: String(row.entity_id),
    op: String(row.op) as SyncJournalOperation,
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

export function appendJournalEntry(db: SqliteExecutor, entry: SyncJournalAppendEntry): number {
  assertEntityType(entry.entityType);
  assertOperation(entry.op);
  const origin = entry.origin ?? 'home';
  if (!origin.trim()) {
    throw new Error('sync journal origin must be non-empty');
  }
  const createdAt = entry.createdAt ?? new Date().toISOString();

  db.execRun(
    `INSERT INTO sync_journal (entity_type, entity_id, op, payload, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      entry.entityType,
      entry.entityId,
      entry.op,
      JSON.stringify(entry.payload),
      origin,
      createdAt,
    ],
  );

  const row = db.queryOne('SELECT last_insert_rowid() AS seq');
  return Number(row?.seq ?? 0);
}

export function readJournalSince(
  db: SqliteExecutor,
  seq: number,
  limit: number,
): SyncJournalEntry[] {
  const cursor = normalizeSeq(seq, 'seq');
  const pageLimit = Math.trunc(limit);
  if (!Number.isFinite(pageLimit) || pageLimit <= 0) return [];

  const rows = db.queryAll(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [cursor, pageLimit],
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

export function setSyncCursor(db: SqliteExecutor, cursor: SyncCursorPatch): SyncCursor {
  const previous = getSyncCursor(db, cursor.peerId);
  const lastSentSeq = normalizeSeq(cursor.lastSentSeq ?? previous?.lastSentSeq ?? 0, 'lastSentSeq');
  const lastReceivedSeq = normalizeSeq(
    cursor.lastReceivedSeq ?? previous?.lastReceivedSeq ?? 0,
    'lastReceivedSeq',
  );
  const updatedAt = cursor.updatedAt ?? new Date().toISOString();

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
