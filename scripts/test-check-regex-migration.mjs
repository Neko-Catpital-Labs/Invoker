import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

const CHECK = resolve('scripts/check-regex-migration.mjs');
const BASELINE = 'scripts/regex-boundary-baseline.json';
const TARGET = 'packages/workflow-graph/src/failure-classifier.ts';
const ROOTS = [
  'packages/contracts/src',
  'packages/execution-engine/src',
  'packages/persistence/src',
  'packages/workflow-core/src',
  'packages/workflow-graph/src',
];

function run(args = [], cwd = process.cwd()) {
  try {
    return { code: 0, out: execFileSync('node', [CHECK, ...args], { encoding: 'utf8', cwd }) };
  } catch (err) {
    return { code: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const failures = [];
const check = (name, cond, detail) => {
  if (cond) console.log(`ok - ${name}`);
  else { console.error(`FAIL - ${name}: ${detail}`); failures.push(name); }
};

const savedTarget = readFileSync(TARGET, 'utf8');
const sandbox = mkdtempSync(join(tmpdir(), 'regex-baseline-'));
const sandboxTarget = join(sandbox, TARGET);
const sandboxBaseline = join(sandbox, BASELINE);

try {
  const clean = run();
  check('clean tree passes at baseline', clean.code === 0, `exit ${clean.code}: ${clean.out}`);

  for (const root of ROOTS) mkdirSync(join(sandbox, root), { recursive: true });
  mkdirSync(dirname(sandboxBaseline), { recursive: true });
  writeFileSync(sandboxTarget, savedTarget);

  const seeded = run(['--update'], sandbox);
  check('sandbox baseline seeds from --update', seeded.code === 0, `exit ${seeded.code}: ${seeded.out}`);
  const seededCount = JSON.parse(readFileSync(sandboxBaseline, 'utf8'))[TARGET];
  check('sandbox baseline records the target file', Number.isInteger(seededCount), `got ${seededCount}`);
  check('sandbox tree passes at its own baseline', run([], sandbox).code === 0, 'expected exit 0');

  writeFileSync(sandboxTarget, `${savedTarget}\nconst EXTRA_A = /x/.test('y');\nconst EXTRA_B = new RegExp('z');\n`);
  const regressed = run([], sandbox);
  check('added regex fails the ratchet', regressed.code === 1, `exit ${regressed.code}`);
  check('failure names the file and the counts',
    regressed.out.includes(`${TARGET}: ${seededCount} -> ${seededCount + 2}`), regressed.out);

  writeFileSync(sandboxTarget, `${savedTarget}\nconst EXTRA_C = /x/.exec('y');\nconst EXTRA_D = [...'y'.matchAll(/x/g)];\n`);
  const execRegressed = run([], sandbox);
  check('added .exec( on a regex literal fails the ratchet', execRegressed.code === 1, `exit ${execRegressed.code}`);
  check('added .matchAll( is counted too',
    execRegressed.out.includes(`${TARGET}: ${seededCount} -> ${seededCount + 2}`), execRegressed.out);

  writeFileSync(sandboxTarget, `${savedTarget}\nconst EXTRA_E = await this.exec('gh', ['pr', 'view']);\nconst EXTRA_F = await cp.exec('git status');\n`);
  const shellExec = run([], sandbox);
  check('shell .exec( calls are not counted as regexes', shellExec.code === 0, `exit ${shellExec.code}: ${shellExec.out}`);
  writeFileSync(sandboxTarget, savedTarget);

  writeFileSync(sandboxBaseline, '{ not json');
  const unreadable = run([], sandbox);
  check('unreadable baseline is neither pass nor regression (exit 2)', unreadable.code === 2, `exit ${unreadable.code}`);
  check('unreadable baseline says the check could not run',
    unreadable.out.includes('does not pass'), unreadable.out);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nAll regex-boundary checks passed');
