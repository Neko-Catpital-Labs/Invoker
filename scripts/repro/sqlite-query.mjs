#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';

const [, , dbPath, ...sqlParts] = process.argv;

if (!dbPath || sqlParts.length === 0) {
  console.error('usage: node scripts/repro/sqlite-query.mjs <db-path> <sql>');
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });

try {
  for (const row of db.prepare(sqlParts.join(' ')).all()) {
    console.log(Object.values(row).map((value) => value ?? '').join('|'));
  }
} finally {
  db.close();
}
