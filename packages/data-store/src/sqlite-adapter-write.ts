import type { Database as SqlJsDatabase } from 'sql.js';

export interface SQLiteWriteContext {
  db: SqlJsDatabase;
  readOnly: boolean;
  dirty: boolean;
  writeTransactionDepth: number;
  scheduleFlush(): void;
}

export function ensureSQLiteWritable(context: Pick<SQLiteWriteContext, 'readOnly'>): void {
  if (context.readOnly) {
    throw new Error('SQLiteAdapter is read-only in this process');
  }
}

/** Run an INSERT/UPDATE/DELETE and schedule a flush. */
export function execSQLiteRun(
  context: SQLiteWriteContext,
  sql: string,
  params: unknown[] = [],
): void {
  ensureSQLiteWritable(context);
  context.db.run(sql, params as any[]);
  context.dirty = true;
  if (context.writeTransactionDepth === 0) {
    context.scheduleFlush();
  }
}

export function runSQLiteTransaction<T>(context: SQLiteWriteContext, work: () => T): T {
  ensureSQLiteWritable(context);
  context.db.run('BEGIN');
  context.writeTransactionDepth += 1;
  try {
    const result = work();
    context.writeTransactionDepth -= 1;
    context.db.run('COMMIT');
    context.dirty = true;
    context.scheduleFlush();
    return result;
  } catch (err) {
    context.writeTransactionDepth = Math.max(0, context.writeTransactionDepth - 1);
    try {
      context.db.run('ROLLBACK');
    } catch {
      // Preserve the original statement failure if SQLite already aborted the
      // transaction before we reached this cleanup path.
    }
    throw err;
  }
}
