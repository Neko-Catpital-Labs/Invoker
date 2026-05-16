import type { Database as SqlJsDatabase } from 'sql.js';

/** Run a single-row SELECT, returning the row as an object or undefined. */
export function queryOne(
  db: SqlJsDatabase,
  sql: string,
  params: unknown[] = [],
): Record<string, unknown> | undefined {
  const stmt = db.prepare(sql);
  stmt.bind(params as any[]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row as Record<string, unknown>;
  }
  stmt.free();
  return undefined;
}

/** Run a multi-row SELECT, returning an array of row objects. */
export function queryAll(
  db: SqlJsDatabase,
  sql: string,
  params: unknown[] = [],
): Record<string, unknown>[] {
  const stmt = db.prepare(sql);
  stmt.bind(params as any[]);
  const rows: Record<string, unknown>[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as Record<string, unknown>);
  }
  stmt.free();
  return rows;
}
