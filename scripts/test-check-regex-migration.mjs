import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHECK = 'scripts/check-regex-migration.mjs';
const BASELINE = 'scripts/regex-boundary-baseline.json';
const TARGET = 'packages/workflow-graph/src/failure-classifier.ts';

function run(args = []) {
  try {
    return { code: 0, out: execFileSync('node', [CHECK, ...args], { encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const failures = [];
const check = (name, cond, detail) => {
  if (cond) console.log(`ok - ${name}`);
  else { console.error(`FAIL - ${name}: ${detail}`); failures.push(name); }
};

const savedBaseline = readFileSync(BASELINE, 'utf8');
const savedTarget = readFileSync(TARGET, 'utf8');

try {
  const clean = run();
  check('clean tree passes at baseline', clean.code === 0, `exit ${clean.code}: ${clean.out}`);

  writeFileSync(TARGET, `${savedTarget}\nconst EXTRA_A = /x/.test('y');\nconst EXTRA_B = new RegExp('z');\n`);
  const regressed = run();
  check('added regex fails the ratchet', regressed.code === 1, `exit ${regressed.code}`);
  check('failure names the file and the counts',
    regressed.out.includes(TARGET) && /\d+ -> \d+/.test(regressed.out), regressed.out);
  writeFileSync(TARGET, savedTarget);

  const dir = mkdtempSync(join(tmpdir(), 'regex-baseline-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(BASELINE, '{ not json');
  const unreadable = run();
  check('unreadable baseline is neither pass nor regression (exit 2)', unreadable.code === 2, `exit ${unreadable.code}`);
  check('unreadable baseline says the check could not run',
    unreadable.out.includes('does not pass'), unreadable.out);
  rmSync(dir, { recursive: true, force: true });
} finally {
  writeFileSync(BASELINE, savedBaseline);
  writeFileSync(TARGET, savedTarget);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nAll regex-boundary checks passed');
