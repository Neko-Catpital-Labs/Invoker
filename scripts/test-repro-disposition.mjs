import assert from 'node:assert/strict';
import { classifyRepros, listReproFiles } from './repro-disposition.mjs';

const rows = classifyRepros();
const paths = listReproFiles();
const seen = new Set(rows.map((row) => row.path));
const missing = paths.filter((path) => !seen.has(path));
assert.deepEqual(missing, [], 'every repro file must have a disposition');
const extra = rows.filter((row) => !paths.includes(row.path)).map((row) => row.path);
assert.deepEqual(extra, []);
const open = rows.filter((row) => row.disposition === 'unclassified' || !row.proof);
assert.deepEqual(open.map((row) => row.path), []);
const counts = {};
for (const row of rows) counts[row.disposition] = (counts[row.disposition] ?? 0) + 1;
console.log(JSON.stringify(counts));
