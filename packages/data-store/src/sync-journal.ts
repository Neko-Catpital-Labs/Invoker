import type { SqliteExecutor } from './sqlite-executor.js';

export const SYNC_JOURNAL_ENTITY_TYPES = [
  'workflow',
  'task',
  'attempt',
  'event',
  // Reserved for output synchronization. High-volume output_spool writes are
  // intentionally not journaled until batching/compaction semantics exist.
  'output',
] as const;

export type SyncJournalEntityType = (typeof SYNC_JOURNAL_ENTITY_TYPES)[number];
export type SyncJournalOperation = 'upsert' | 'tombstone';

export interface SyncJournalEntryInput {
  entityType: SyncJournalEntityType;
  entityId: string;
  op: SyncJournalOperation;
  payload: unknown;
  origin?: string;
  createdAt?: number;
}

export interface SyncJournalEntry {
  seq: number;
  entityType: SyncJournalEntityType;
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

const ENTITY_TYPES = new Set<string>(SYNC_JOURNAL_ENTITY_TYPES);
const OPERATIONS = new Set<string>(['upsert', 'tombstone']);

function assertEntityType(value: string): asserts value is SyncJournalEntityType {
  if (!ENTITY_TYPES.has(value)) {
    throw new Error(`Invalid sync journal entity_type: ${value}`);
  }
}

function assertOperation(value: string): asserts value is SyncJournalOperation {
  if (!OPERATIONS.has(value)) {
    throw new Error(`Invalid sync journal op: ${value}`);
  }
}

function normalizeSeq(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function normalizeLimit(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('limit must be a positive integer');
  }
  return value;
}

export function appendJournalEntry(db: SqliteExecutor, entry: SyncJournalEntryInput): number {
  assertEntityType(entry.entityType);
  assertOperation(entry.op);
  if (!entry.entityId) {
    throw new Error('sync journal entityId is required');
  }
  const origin = entry.origin ?? 'home';
  if (!origin) {
    throw new Error('sync journal origin is required');
  }
  const payload = JSON.stringify(entry.payload);
  if (payload === undefined) {
    throw new Error('sync journal payload must be JSON-serializable');
  }
  const createdAt = entry.createdAt ?? Date.now();
  normalizeSeq(createdAt, 'createdAt');

  db.execRun(
    `INSERT INTO sync_journal (
      entity_type, entity_id, op, payload, origin, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    [entry.entityType, entry.entityId, entry.op, payload, origin, createdAt],
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
  const cappedLimit = normalizeLimit(limit);
  const rows = db.queryAll(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [cursor, cappedLimit],
  );

  return rows.map((row) => {
    const entityType = String(row.entity_type ?? '');
    const op = String(row.op ?? '');
    assertEntityType(entityType);
    assertOperation(op);
    return {
      seq: Number(row.seq),
      entityType,
      entityId: String(row.entity_id),
      op,
      payload: JSON.parse(String(row.payload)),
      origin: String(row.origin),
      createdAt: Number(row.created_at),
    };
  });
}

export function getSyncCursor(db: SqliteExecutor, peerId: string): SyncCursor | undefined {
  if (!peerId) {
    throw new Error('peerId is required');
  }
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

export function setSyncCursor(
  db: SqliteExecutor,
  cursor: Pick<SyncCursor, 'peerId' | 'lastSentSeq' | 'lastReceivedSeq'> & Partial<Pick<SyncCursor, 'updatedAt'>>,
): SyncCursor {
  if (!cursor.peerId) {
    throw new Error('peerId is required');
  }
  const lastSentSeq = normalizeSeq(cursor.lastSentSeq, 'lastSentSeq');
  const lastReceivedSeq = normalizeSeq(cursor.lastReceivedSeq, 'lastReceivedSeq');
  const updatedAt = cursor.updatedAt ?? Date.now();
  normalizeSeq(updatedAt, 'updatedAt');

  db.execRun(
    `INSERT INTO sync_cursors (
      peer_id, last_sent_seq, last_received_seq, updated_at
    ) VALUES (?, ?, ?, ?)
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
