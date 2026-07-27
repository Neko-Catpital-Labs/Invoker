import type { SqliteExecutor } from './sqlite-executor.js';

export type SyncJournalEntityType = 'workflow' | 'task' | 'attempt' | 'event' | 'output';
export type SyncJournalOperation = 'upsert' | 'tombstone';

export interface SyncJournalEntryInput {
  entityType: SyncJournalEntityType;
  entityId: string;
  op: SyncJournalOperation;
  payload: unknown;
  /** Local owner writes use `home`; remote replay can stamp the source machine id later. */
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

export interface SyncCursorValues {
  lastSentSeq?: number;
  lastReceivedSeq?: number;
  updatedAt?: number;
}

export type SyncCursorUpdate = SyncCursorValues & { peerId: string };

export type SyncJournalDb = Pick<SqliteExecutor, 'queryOne' | 'queryAll' | 'execRun'>;

// `output` is intentionally part of the enum for the future output-spool sync
// journal, but the adapter does not append high-volume output entries yet.
const ENTITY_TYPES: ReadonlySet<string> = new Set(['workflow', 'task', 'attempt', 'event', 'output']);
const OPERATIONS: ReadonlySet<string> = new Set(['upsert', 'tombstone']);

export function appendJournalEntry(db: SyncJournalDb, entry: SyncJournalEntryInput): number {
  if (!ENTITY_TYPES.has(entry.entityType)) {
    throw new Error(`Invalid sync journal entity_type: ${entry.entityType}`);
  }
  if (!OPERATIONS.has(entry.op)) {
    throw new Error(`Invalid sync journal op: ${entry.op}`);
  }

  const payloadJson = JSON.stringify(entry.payload ?? null);
  db.execRun(
    `INSERT INTO sync_journal (entity_type, entity_id, op, payload, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      entry.entityType,
      entry.entityId,
      entry.op,
      payloadJson,
      entry.origin ?? 'home',
      entry.createdAt ?? Date.now(),
    ],
  );

  const row = db.queryOne('SELECT last_insert_rowid() AS seq');
  return Number(row?.seq ?? 0);
}

export function readJournalSince(
  db: SyncJournalDb,
  seq: number,
  limit: number,
): SyncJournalEntry[] {
  const cappedLimit = Math.max(0, Math.trunc(limit));
  if (cappedLimit === 0) return [];

  const rows = db.queryAll(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    [Math.max(0, Math.trunc(seq)), cappedLimit],
  );
  return rows.map(mapJournalRow);
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

export function setSyncCursor(db: SyncJournalDb, cursor: SyncCursorUpdate): void;
export function setSyncCursor(db: SyncJournalDb, peerId: string, values: SyncCursorValues): void;
export function setSyncCursor(
  db: SyncJournalDb,
  cursorOrPeerId: SyncCursorUpdate | string,
  values: SyncCursorValues = {},
): void {
  const peerId = typeof cursorOrPeerId === 'string' ? cursorOrPeerId : cursorOrPeerId.peerId;
  const patch = typeof cursorOrPeerId === 'string' ? values : cursorOrPeerId;
  const existing = getSyncCursor(db, peerId);
  const lastSentSeq = patch.lastSentSeq ?? existing?.lastSentSeq ?? 0;
  const lastReceivedSeq = patch.lastReceivedSeq ?? existing?.lastReceivedSeq ?? 0;
  const updatedAt = patch.updatedAt ?? Date.now();

  db.execRun(
    `INSERT INTO sync_cursors (peer_id, last_sent_seq, last_received_seq, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(peer_id) DO UPDATE SET
       last_sent_seq = excluded.last_sent_seq,
       last_received_seq = excluded.last_received_seq,
       updated_at = excluded.updated_at`,
    [peerId, lastSentSeq, lastReceivedSeq, updatedAt],
  );
}

function mapJournalRow(row: Record<string, unknown>): SyncJournalEntry {
  return {
    seq: Number(row.seq ?? 0),
    entityType: String(row.entity_type) as SyncJournalEntityType,
    entityId: String(row.entity_id),
    op: String(row.op) as SyncJournalOperation,
    payload: JSON.parse(String(row.payload ?? 'null')),
    origin: String(row.origin ?? ''),
    createdAt: Number(row.created_at ?? 0),
  };
}

function mapCursorRow(row: Record<string, unknown>): SyncCursor {
  return {
    peerId: String(row.peer_id),
    lastSentSeq: Number(row.last_sent_seq ?? 0),
    lastReceivedSeq: Number(row.last_received_seq ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}
