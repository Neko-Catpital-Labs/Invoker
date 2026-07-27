import type { SqliteExecutor } from './sqlite-executor.js';

export type SyncEntityType = 'workflow' | 'task' | 'attempt' | 'event' | 'output';
export type SyncJournalOperation = 'upsert' | 'tombstone';

export interface SyncJournalEntry {
  entityType: SyncEntityType;
  entityId: string;
  op: SyncJournalOperation;
  payload: unknown;
  origin?: string;
  createdAt?: number;
}

export interface SyncJournalRow {
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

const ENTITY_TYPES = new Set<SyncEntityType>([
  'workflow',
  'task',
  'attempt',
  'event',
  // Reserved for future output-spool sync; adapter output writes are not
  // journaled yet because they are high-volume.
  'output',
]);

const OPS = new Set<SyncJournalOperation>(['upsert', 'tombstone']);

function assertEntityType(value: SyncEntityType): void {
  if (!ENTITY_TYPES.has(value)) {
    throw new Error(`Invalid sync journal entity_type "${String(value)}"`);
  }
}

function assertOp(value: SyncJournalOperation): void {
  if (!OPS.has(value)) {
    throw new Error(`Invalid sync journal op "${String(value)}"`);
  }
}

function assertNonEmptyString(label: string, value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertNonNegativeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function payloadToJson(payload: unknown): string {
  const json = JSON.stringify(payload);
  if (json === undefined) {
    throw new Error('sync journal payload must be JSON-serializable');
  }
  return json;
}

function parsePayload(raw: unknown, seq: unknown): unknown {
  try {
    return JSON.parse(String(raw));
  } catch (err) {
    throw new Error(
      `Invalid sync journal payload JSON at seq ${String(seq)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function appendJournalEntry(db: SqliteExecutor, entry: SyncJournalEntry): number {
  assertEntityType(entry.entityType);
  assertOp(entry.op);
  assertNonEmptyString('sync journal entityId', entry.entityId);
  const origin = entry.origin ?? 'home';
  assertNonEmptyString('sync journal origin', origin);
  const createdAt = entry.createdAt ?? Date.now();
  assertNonNegativeInteger('sync journal createdAt', createdAt);
  const payloadJson = payloadToJson(entry.payload);

  db.execRun(
    `INSERT INTO sync_journal (entity_type, entity_id, op, payload, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [entry.entityType, entry.entityId, entry.op, payloadJson, origin, createdAt],
  );

  const row = db.queryOne('SELECT last_insert_rowid() AS seq') as { seq?: number | bigint } | undefined;
  const seq = Number(row?.seq ?? 0);
  if (!Number.isSafeInteger(seq) || seq <= 0) {
    throw new Error('Could not resolve sync journal seq after insert');
  }
  return seq;
}

export function readJournalSince(db: SqliteExecutor, seq: number, limit: number): SyncJournalRow[] {
  assertNonNegativeInteger('sync journal seq', Math.trunc(seq));
  const pageLimit = Math.trunc(limit);
  if (pageLimit <= 0) return [];
  assertNonNegativeInteger('sync journal limit', pageLimit);

  const rows = db.queryAll(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [Math.trunc(seq), pageLimit],
  );

  return rows.map((row) => ({
    seq: Number(row.seq ?? 0),
    entityType: row.entity_type as SyncEntityType,
    entityId: String(row.entity_id),
    op: row.op as SyncJournalOperation,
    payload: parsePayload(row.payload, row.seq),
    origin: String(row.origin ?? 'home'),
    createdAt: Number(row.created_at ?? 0),
  }));
}

export function getSyncCursor(db: SqliteExecutor, peerId: string): SyncCursor | undefined {
  assertNonEmptyString('sync cursor peerId', peerId);
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
    updatedAt: Number(row.updated_at ?? 0),
  };
}

export function setSyncCursor(db: SqliteExecutor, cursor: SyncCursorInput): SyncCursor {
  assertNonEmptyString('sync cursor peerId', cursor.peerId);
  assertNonNegativeInteger('sync cursor lastSentSeq', cursor.lastSentSeq);
  assertNonNegativeInteger('sync cursor lastReceivedSeq', cursor.lastReceivedSeq);
  const updatedAt = cursor.updatedAt ?? Date.now();
  assertNonNegativeInteger('sync cursor updatedAt', updatedAt);

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
