/**
 * SqliteExecutor — the narrow database-access seam shared between SQLiteAdapter
 * and the migration routines extracted into sqlite-migrations.ts.
 *
 * The four primitives (queryOne/queryAll/execRun/runTransaction) mirror the
 * private SQLiteAdapter helpers of the same name. The remaining members are
 * raw-connection escape hatches the DDL-level schema migrations require: reading
 * the rows changed by the last `run`, issuing PRAGMA/DDL through the raw `run`,
 * short-circuiting on `readOnly`, and flagging the connection dirty.
 */
export interface SqliteExecutor {
  /** Run a single-row SELECT, returning the row as an object or undefined. */
  queryOne(sql: string, params?: unknown[]): Record<string, unknown> | undefined;
  /** Run a multi-row SELECT, returning an array of row objects. */
  queryAll(sql: string, params?: unknown[]): Record<string, unknown>[];
  /** Run an INSERT/UPDATE/DELETE through the writable, dirty-tracking path. */
  execRun(sql: string, params?: unknown[]): void;
  /** Run `work` inside an immediate (or nested savepoint) write transaction. */
  runTransaction<T>(work: () => T): T;
  /** Raw connection run for PRAGMA/DDL statements issued by schema migrations. */
  run(sql: string, params?: unknown[]): void;
  /** Rows changed by the most recent {@link SqliteExecutor.run}. */
  getRowsModified(): number;
  /** True when the adapter is read-only; migrations short-circuit on it. */
  readonly readOnly: boolean;
  /** Mark the connection dirty after a raw DDL mutation. */
  markDirty(): void;
}
