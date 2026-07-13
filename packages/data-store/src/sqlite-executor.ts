export interface SqliteExecutor {
  queryOne(sql: string, params?: unknown[]): Record<string, unknown> | undefined;
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
