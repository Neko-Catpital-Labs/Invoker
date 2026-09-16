import type * as NodeSqlite from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof NodeSqlite;
const { dbPath } = workerData as { dbPath: string };
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  parentPort?.postMessage(db.prepare('PRAGMA quick_check').all());
} finally {
  db.close();
}
