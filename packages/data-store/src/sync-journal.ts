import type { SqliteExecutor } from './sqlite-executor.js';

export const SYNC_JOURNAL_ENTITY_TYPES = [
  'workflow',
  'task',
  'attempt',
  'event',
  // Reserved for future output-spool sync. High-volume output rows are not
  // journaled by adapter mutation paths yet.
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

export interface SyncCursorWrite {
  peerId: string;
  lastSentSeq: number;
  lastReceivedSeq: number;
  updatedAt?: string;
}

type SyncEntityTable = Exclude<SyncJournalEntityType, 'output'>;

const ENTITY_ROW_SELECT: Record<SyncEntityTable, string> = {
  workflow: 'SELECT * FROM workflows WHERE id = ?',
  task: 'SELECT * FROM tasks WHERE id = ?',
  attempt: 'SELECT * FROM attempts WHERE id = ?',
  event: 'SELECT * FROM events WHERE id = ?',
};

function serializeJournalPayload(payload: unknown): string {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) {
    throw new Error('sync journal payload must be JSON-serializable');
  }
  return serialized;
}

function parseJournalPayload(raw: unknown, seq: unknown): unknown {
  try {
    return JSON.parse(String(raw));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid sync_journal payload JSON at seq ${String(seq)}: ${message}`);
  }
}

function normalizeEntityType(value: unknown): SyncJournalEntityType {
  if ((SYNC_JOURNAL_ENTITY_TYPES as readonly unknown[]).includes(value)) {
    return value as SyncJournalEntityType;
  }
  throw new Error(`Invalid sync journal entity_type: ${String(value)}`);
}

function normalizeOperation(value: unknown): SyncJournalOperation {
  if (value === 'upsert' || value === 'tombstone') return value;
  throw new Error(`Invalid sync journal op: ${String(value)}`);
}

function mapJournalRow(row: Record<string, unknown>): SyncJournalEntry {
  return {
    seq: Number(row.seq),
    entityType: normalizeEntityType(row.entity_type),
    entityId: String(row.entity_id),
    op: normalizeOperation(row.op),
    payload: parseJournalPayload(row.payload, row.seq),
    origin: String(row.origin),
    createdAt: String(row.created_at),
  };
}

export function appendJournalEntry(db: SqliteExecutor, entry: SyncJournalEntryInput): SyncJournalEntry {
  const origin = entry.origin ?? 'home';
  const createdAt = entry.createdAt ?? new Date().toISOString();
  db.execRun(
    `INSERT INTO sync_journal (
      entity_type, entity_id, op, payload, origin, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      entry.entityType,
      entry.entityId,
      entry.op,
      serializeJournalPayload(entry.payload),
      origin,
      createdAt,
    ],
  );
  const seqRow = db.queryOne('SELECT last_insert_rowid() AS seq') as { seq?: number | bigint } | undefined;
  const seq = Number(seqRow?.seq ?? 0);
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

export function appendEntitySnapshotJournalEntry(
  db: SqliteExecutor,
  entityType: SyncEntityTable,
  entityId: string,
  op: SyncJournalOperation,
): SyncJournalEntry {
  const row = db.queryOne(ENTITY_ROW_SELECT[entityType], [entityId]);
  if (!row) {
    throw new Error(`Cannot append sync journal entry for missing ${entityType} "${entityId}"`);
  }
  return appendJournalEntry(db, {
    entityType,
    entityId,
    op,
    payload: row,
  });
}

export function readJournalSince(
  db: SqliteExecutor,
  seq: number,
  limit: number,
): SyncJournalEntry[] {
  const safeSeq = Math.max(0, Math.trunc(seq));
  const safeLimit = Math.max(0, Math.trunc(limit));
  if (safeLimit === 0) return [];

  const rows = db.queryAll(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [safeSeq, safeLimit],
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
  if (!row) return undefined;
  return {
    peerId: String(row.peer_id),
    lastSentSeq: Number(row.last_sent_seq ?? 0),
    lastReceivedSeq: Number(row.last_received_seq ?? 0),
    updatedAt: String(row.updated_at),
  };
}

export function setSyncCursor(db: SqliteExecutor, cursor: SyncCursorWrite): SyncCursor {
  const updatedAt = cursor.updatedAt ?? new Date().toISOString();
  db.execRun(
    `INSERT INTO sync_cursors (
      peer_id, last_sent_seq, last_received_seq, updated_at
    ) VALUES (?, ?, ?, ?)
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
