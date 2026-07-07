/**
 * SqliteExecutor — the narrow query/exec surface the migration routines need.
 *
 * {@link SQLiteAdapter} builds one of these from its private helpers so the
 * free functions in `./sqlite-migrations.ts` run the same statements through the
 * same code paths, with `this` binding preserved. This mirrors the pure-module
 * seam already used by `./sqlite-row-mappers.ts`.
 */
export interface SqliteExecutor {
  /** Run a single-row SELECT, returning the row as an object or undefined. */
  queryOne(sql: string, params?: unknown[]): Record<string, unknown> | undefined;
  /** Run a multi-row SELECT, returning an array of row objects. */
  queryAll(sql: string, params?: unknown[]): Record<string, unknown>[];
  /** Run an INSERT/UPDATE/DELETE. File-backed durability is handled by SQLite/WAL. */
  execRun(sql: string, params?: unknown[]): void;
  /** Run `work` inside a transaction; nested calls use savepoints. */
  runTransaction<T>(work: () => T): T;
}
