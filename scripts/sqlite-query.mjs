#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function usage() {
  process.stderr.write(
    'Usage: node scripts/sqlite-query.mjs [--noheader] [--separator <sep>|--tabs] <dbPath> <sql>\n',
  );
}

const args = process.argv.slice(2);
let noHeader = false;
let separator = '|';

while (args.length > 0 && args[0]?.startsWith('--')) {
  const flag = args.shift();
  if (flag === '--noheader') {
    noHeader = true;
    continue;
  }
  if (flag === '--tabs') {
    separator = '\t';
    continue;
  }
  if (flag === '--separator') {
    const next = args.shift();
    if (next === undefined) {
      usage();
      process.exit(2);
    }
    separator = next;
    continue;
  }
  usage();
  process.exit(2);
}

if (args.length < 2) {
  usage();
  process.exit(2);
}

const [dbPath, sql] = args;
const pnpmRoot = path.join(process.cwd(), 'node_modules', '.pnpm');
const sqlJsPackageDir = existsSync(pnpmRoot)
  ? readdirSync(pnpmRoot)
    .map((entry) => path.join(pnpmRoot, entry, 'node_modules', 'sql.js'))
    .find((candidate) => existsSync(path.join(candidate, 'package.json')))
  : null;

if (!sqlJsPackageDir) {
  process.stderr.write('Could not locate sql.js under node_modules/.pnpm\n');
  process.exit(1);
}

const sqlJsModule = await import(pathToFileURL(path.join(sqlJsPackageDir, 'dist', 'sql-wasm.js')).href);
const initSqlJs = sqlJsModule.default;
const SQL = await initSqlJs({
  locateFile: (file) => path.join(sqlJsPackageDir, 'dist', file),
});
const db = new SQL.Database(readFileSync(dbPath));

try {
  const results = db.exec(sql);
  if (results.length === 0) {
    process.exit(0);
  }

  for (const result of results) {
    if (!noHeader) {
      process.stdout.write(`${result.columns.join(separator)}\n`);
    }
    for (const row of result.values) {
      process.stdout.write(`${row.map((value) => String(value ?? '')).join(separator)}\n`);
    }
  }
} finally {
  db.close();
}
