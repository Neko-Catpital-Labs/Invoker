import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOTS = [
  'packages/contracts/src',
  'packages/execution-engine/src',
  'packages/persistence/src',
  'packages/workflow-core/src',
  'packages/workflow-graph/src',
];
const BASELINE_PATH = 'scripts/regex-boundary-baseline.json';
const FORBIDDEN = ['new RegExp', '.match(', '.search(', '.test('];

async function productionFiles(root) {
  const found = [];
  const visit = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') await visit(child);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        found.push(child);
      }
    }
  };
  await visit(root);
  return found;
}

async function countsByFile() {
  const counts = {};
  for (const root of ROOTS) {
    for (const file of (await productionFiles(root)).sort()) {
      const hits = (await readFile(file, 'utf8'))
        .split('\n')
        .filter((line) => FORBIDDEN.some((marker) => line.includes(marker)))
        .length;
      if (hits > 0) counts[file] = hits;
    }
  }
  return counts;
}

const counts = await countsByFile();

if (process.argv.includes('--update')) {
  await writeFile(BASELINE_PATH, `${JSON.stringify(counts, null, 2)}\n`);
  console.log(`Regex boundary baseline written: ${Object.keys(counts).length} files`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
} catch (err) {
  console.error(`Cannot read ${BASELINE_PATH}: ${err.message}`);
  console.error('The check cannot run, so it does not pass. Regenerate with --update.');
  process.exit(2);
}

const regressions = [];
for (const [file, count] of Object.entries(counts)) {
  const allowed = baseline[file] ?? 0;
  if (count > allowed) regressions.push(`${file}: ${allowed} -> ${count}`);
}

if (regressions.length > 0) {
  console.error('Regex-over-prose regressions (a domain decision must read a typed value, not a string):');
  console.error(regressions.join('\n'));
  console.error('');
  console.error('If this regex is a named boundary parser that converts external text into a typed');
  console.error('model, re-baseline deliberately with: node scripts/check-regex-migration.mjs --update');
  process.exit(1);
}

console.log(`Regex boundary check clean: ${Object.keys(counts).length} files at or below baseline`);
