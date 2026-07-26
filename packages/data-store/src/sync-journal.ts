// `output` is reserved for future output-spool sync; output rows are not journaled yet.
export type SyncJournalEntityType = 'workflow' | 'task' | 'attempt' | 'event' | 'output';
export type SyncJournalOp = 'upsert' | 'tombstone';

export interface SyncJournalDatabase {
  queryOne(sql: string, params?: unknown[]): Record<string, unknown> | undefined;
  queryAll(sql: string, params?: unknown[]): Record<string, unknown>[];
  execRun(sql: string, params?: unknown[]): void;
}

export interface SyncJournalAppendEntry {
  entityType: SyncJournalEntityType;
  entityId: string;
  op: SyncJournalOp;
  payload: unknown;
  /** Local writes originate at home until remote transport assigns peer origins. */
  origin?: string;
  createdAt?: number;
}

export interface SyncJournalEntry {
  seq: number;
  entityType: SyncJournalEntityType;
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

export interface SyncCursorWrite {
  peerId: string;
  lastSentSeq: number;
  lastReceivedSeq: number;
  updatedAt?: number;
}

const DEFAULT_ORIGIN = 'home';

function nowMs(): number {
  return Date.now();
}

function rowToJournalEntry(row: Record<string, unknown>): SyncJournalEntry {
  return {
    seq: Number(row.seq),
    entityType: String(row.entity_type) as SyncJournalEntityType,
    entityId: String(row.entity_id),
    op: String(row.op) as SyncJournalOp,
    payload: JSON.parse(String(row.payload)),
    origin: String(row.origin),
    createdAt: Number(row.created_at),
  };
}

function rowToCursor(row: Record<string, unknown>): SyncCursor {
  return {
    peerId: String(row.peer_id),
    lastSentSeq: Number(row.last_sent_seq),
    lastReceivedSeq: Number(row.last_received_seq),
    updatedAt: Number(row.updated_at),
  };
}

export function appendJournalEntry(
  db: SyncJournalDatabase,
  entry: SyncJournalAppendEntry,
): SyncJournalEntry {
  db.execRun(
    `INSERT INTO sync_journal (
      entity_type, entity_id, op, payload, origin, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      entry.entityType,
      entry.entityId,
      entry.op,
      JSON.stringify(entry.payload),
      entry.origin ?? DEFAULT_ORIGIN,
      entry.createdAt ?? nowMs(),
    ],
  );

  const row = db.queryOne(
    `SELECT seq, entity_type, entity_id, op, payload, origin, created_at
       FROM sync_journal
      WHERE seq = last_insert_rowid()`,
  );
  if (!row) {
    throw new Error('Failed to read appended sync journal entry');
  }
  return rowToJournalEntry(row);
}

export function readJournalSince(
  db: SyncJournalDatabase,
  seq: number,
  limit: number,
): SyncJournalEntry[] {
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
  return rows.map((row) => rowToJournalEntry(row));
}

export function getSyncCursor(
  db: SyncJournalDatabase,
  peerId: string,
): SyncCursor | undefined {
  const row = db.queryOne(
    `SELECT peer_id, last_sent_seq, last_received_seq, updated_at
       FROM sync_cursors
      WHERE peer_id = ?`,
    [peerId],
  );
  return row ? rowToCursor(row) : undefined;
}

export function setSyncCursor(
  db: SyncJournalDatabase,
  cursor: SyncCursorWrite,
): SyncCursor {
  const updatedAt = cursor.updatedAt ?? nowMs();
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

  const saved = getSyncCursor(db, cursor.peerId);
  if (!saved) {
    throw new Error(`Failed to read sync cursor for peer ${cursor.peerId}`);
  }
  return saved;
}
