import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';

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

  writeFileSync(TARGET, `${savedTarget}\nconst EXTRA_C = SOME_PATTERN.exec(text);\nconst EXTRA_D = [...text.matchAll(/y/g)];\n`);
  const widened = run();
  check('regex .exec( and .matchAll( fail the ratchet', widened.code === 1, `exit ${widened.code}`);
  check('widened failure counts both added lines', /: \d+ -> \d+/.test(widened.out) && widened.out.includes(TARGET), widened.out);
  writeFileSync(TARGET, savedTarget);

  writeFileSync(TARGET, `${savedTarget}\nconst EXTRA_E = await this.exec('gh', args, cwd);\n`);
  const subprocess = run();
  check('a subprocess this.exec( call does not trip the gate', subprocess.code === 0, `exit ${subprocess.code}: ${subprocess.out}`);
  writeFileSync(TARGET, savedTarget);

  writeFileSync(BASELINE, '{ not json');
  const unreadable = run();
  check('unreadable baseline is neither pass nor regression (exit 2)', unreadable.code === 2, `exit ${unreadable.code}`);
  check('unreadable baseline says the check could not run',
    unreadable.out.includes('does not pass'), unreadable.out);
} finally {
  writeFileSync(BASELINE, savedBaseline);
  writeFileSync(TARGET, savedTarget);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nAll regex-boundary checks passed');
