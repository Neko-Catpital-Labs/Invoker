#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [, , dbPath, ...sqlParts] = process.argv;

if (!dbPath || sqlParts.length === 0) {
  console.error('usage: node scripts/repro/sqljs-query.mjs <db-path> <sql>');
  process.exit(2);
}

const sql = sqlParts.join(' ');
const require = createRequire(new URL('../../packages/data-store/package.json', import.meta.url));
const initSqlJs = require('sql.js');
const SQL = await initSqlJs();
const db = new SQL.Database(readFileSync(dbPath));

try {
  const results = db.exec(sql);
  for (const result of results) {
    for (const row of result.values) {
      console.log(row.map((value) => value ?? '').join('|'));
    }
  }
} finally {
  db.close();
}
