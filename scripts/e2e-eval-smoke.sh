#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNNER="$ROOT/scripts/e2e-eval-runner.mjs"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/invoker-e2e-eval-smoke-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

ASSETS="$TMP/assets"
mkdir -p "$ASSETS"

checkout_snapshot() {
  git -C "$ROOT" rev-parse HEAD
  git -C "$ROOT" status --porcelain=v1
}

CHECKOUT_BEFORE="$(checkout_snapshot)"

echo "[smoke] step 1/4: runner self-test"
SELF_TEST_OUTPUT="$("$(command -v node)" "$RUNNER" --self-test)"
echo "$SELF_TEST_OUTPUT"
case "$SELF_TEST_OUTPUT" in
  PASS*) ;;
  *) echo "[smoke] self-test did not print a pass line" >&2; exit 1 ;;
esac

cat > "$ASSETS/sum.mjs" <<'FIXTURE_EOF'
export function sumPositive(values) {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}
FIXTURE_EOF

cat > "$ASSETS/README.md" <<'FIXTURE_README_EOF'
sumPositive(values) must return the sum of the strictly positive entries only.
FIXTURE_README_EOF

cat > "$ASSETS/verify.mjs" <<'VERIFIER_EOF'
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const workdir = process.env.INVOKER_EVAL_WORKDIR;
if (!workdir) {
  console.error('verifier: INVOKER_EVAL_WORKDIR was not provided');
  process.exit(2);
}

const failures = [];

if (existsSync(path.join(workdir, 'verify.mjs'))) {
  failures.push('the verifier suite leaked into the solver workspace');
}

const modulePath = path.join(workdir, 'sum.mjs');
if (!existsSync(modulePath)) {
  failures.push('sum.mjs is missing from the final workspace state');
} else {
  let sumPositive;
  try {
    ({ sumPositive } = await import(pathToFileURL(modulePath).href));
  } catch (error) {
    failures.push(`sum.mjs did not import: ${error.message}`);
  }
  if (typeof sumPositive !== 'function') {
    failures.push('sum.mjs does not export a sumPositive function');
  } else {
    const cases = [
      { input: [1, 2, 3], expected: 6 },
      { input: [1, -5, 2], expected: 3 },
      { input: [-1, -2], expected: 0 },
      { input: [], expected: 0 },
      { input: [0, 4, -4], expected: 4 },
    ];
    for (const testCase of cases) {
      let actual;
      try {
        actual = sumPositive(testCase.input);
      } catch (error) {
        failures.push(`sumPositive(${JSON.stringify(testCase.input)}) threw ${error.message}`);
        continue;
      }
      if (actual !== testCase.expected) {
        failures.push(`sumPositive(${JSON.stringify(testCase.input)}) returned ${actual}, expected ${testCase.expected}`);
      }
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`verifier: ${failure}`);
  console.error(`verifier: ${failures.length} check(s) failed on final workspace state`);
  process.exit(1);
}
console.log('verifier: 5/5 final-state checks passed');
VERIFIER_EOF

cat > "$ASSETS/solver-fix.sh" <<'SOLVER_FIX_EOF'
set -euo pipefail
echo "solver: prompt=${INVOKER_EVAL_PROMPT} model=${INVOKER_EVAL_MODEL} budgetUsd=${INVOKER_EVAL_BUDGET_USD}"
cat > sum.mjs <<'PATCH'
export function sumPositive(values) {
  let total = 0;
  for (const value of values) {
    if (value > 0) total += value;
  }
  return total;
}
PATCH
echo "solver: rewrote sum.mjs"
SOLVER_FIX_EOF

cat > "$ASSETS/solver-claim.sh" <<'SOLVER_CLAIM_EOF'
set -euo pipefail
echo "solver: prompt=${INVOKER_EVAL_PROMPT} model=${INVOKER_EVAL_MODEL} budgetUsd=${INVOKER_EVAL_BUDGET_USD}"
echo "solver: I reviewed sum.mjs and the implementation is already correct. Task complete."
exit 0
SOLVER_CLAIM_EOF

cat > "$TMP/build-manifest.mjs" <<'BUILD_EOF'
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const [assets, outPath] = process.argv.slice(2);
const read = (name) => readFileSync(path.join(assets, name), 'utf8');

const prompt = 'sumPositive in sum.mjs must sum only the strictly positive entries. Fix it.';
const fixture = { files: { 'sum.mjs': read('sum.mjs'), 'README.md': read('README.md') } };
const verifier = {
  command: process.execPath,
  args: ['verify.mjs'],
  files: { 'verify.mjs': read('verify.mjs') },
};

const manifest = {
  schemaVersion: 1,
  name: 'invoker-e2e-eval-smoke',
  defaults: {
    model: 'claude-opus-5',
    budgetUsd: 0.25,
    solverTimeoutMs: 120000,
    verifierTimeoutMs: 60000,
  },
  tasks: [
    {
      id: 'sum-positive-fixed',
      prompt,
      fixture,
      solver: { command: 'bash', args: ['-c', read('solver-fix.sh')] },
      verifier,
    },
    {
      id: 'sum-positive-claimed-without-fixing',
      prompt,
      fixture,
      solver: { command: 'bash', args: ['-c', read('solver-claim.sh')] },
      verifier,
    },
  ],
};

writeFileSync(outPath, JSON.stringify(manifest, null, 2));
BUILD_EOF

cat > "$TMP/check-results.mjs" <<'CHECK_EOF'
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const [resultsPath, taskId, expectedGrade, repoRoot] = process.argv.slice(2);
const lines = readFileSync(resultsPath, 'utf8').trim().split('\n').filter(Boolean);

const failures = [];
const check = (label, condition) => { if (!condition) failures.push(label); };

check(`exactly one result row (got ${lines.length})`, lines.length === 1);
let row = {};
try { row = JSON.parse(lines[0]); } catch (error) { failures.push(`row is not valid JSON: ${error.message}`); }

check('resultSchemaVersion is 1', row.resultSchemaVersion === 1);
check(`taskId is ${taskId}`, row.taskId === taskId);
check('runId is present', typeof row.runId === 'string' && row.runId.length > 0);
check('startedAt and finishedAt are ISO timestamps', !Number.isNaN(Date.parse(row.startedAt)) && !Number.isNaN(Date.parse(row.finishedAt)));
check('model is explicit', typeof row.model === 'string' && row.model.length > 0);
check('budgetUsd is explicit and positive', typeof row.budgetUsd === 'number' && row.budgetUsd > 0);
check(`graded is ${expectedGrade} (got ${row.graded})`, row.graded === expectedGrade);
check('grade is sourced from the verifier exit code', row.gradeSource === 'verifier-exit-code');
check('row records that the solver outcome was ignored', row.gradeIgnoredSolverOutcome === true);
check('independent verifier output is captured', `${row.verifier?.stdout ?? ''}${row.verifier?.stderr ?? ''}`.includes('verifier:'));
check('solver output is captured separately', (row.solver?.stdout ?? '').includes('solver:'));
check('the solver saw the model and budget', (row.solver?.stdout ?? '').includes(row.model));
check('the workspace lived outside the source checkout', typeof row.workspaceDir === 'string' && path.relative(repoRoot, row.workspaceDir).startsWith('..'));
check('the verifier ran outside the solver workspace', row.verifierDir !== row.workspaceDir);

if (expectedGrade === 'fail') {
  check(`the solver exited 0 while grading fail (got ${row.solver?.exitCode})`, row.solver?.exitCode === 0);
  check('the verifier explained the failure', (row.verifier?.stderr ?? '').includes('expected'));
} else {
  check('the verifier reported its passing checks', (row.verifier?.stdout ?? '').includes('5/5'));
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(`[smoke] ${failures.length} result-row assertion(s) failed for ${taskId}`);
  process.exit(1);
}
console.log(`[smoke] result row for ${taskId} verified: graded=${row.graded} model=${row.model} budgetUsd=${row.budgetUsd} verifierExit=${row.verifier?.exitCode} solverExit=${row.solver?.exitCode}`);
CHECK_EOF

MANIFEST="$TMP/manifest.json"
node "$TMP/build-manifest.mjs" "$ASSETS" "$MANIFEST"

echo
echo "[smoke] step 2/4: solver fixes the bug, verifier must grade pass"
set +e
node "$RUNNER" --manifest "$MANIFEST" --task sum-positive-fixed --out "$TMP/pass.jsonl"
PASS_EXIT=$?
set -e
if [ "$PASS_EXIT" -ne 0 ]; then
  echo "[smoke] expected exit 0 for a task the verifier passes, got $PASS_EXIT" >&2
  exit 1
fi
node "$TMP/check-results.mjs" "$TMP/pass.jsonl" sum-positive-fixed pass "$ROOT"

echo
echo "[smoke] step 3/4: solver claims success without fixing, verifier must grade fail"
set +e
node "$RUNNER" --manifest "$MANIFEST" --task sum-positive-claimed-without-fixing --out "$TMP/fail.jsonl"
FAIL_EXIT=$?
set -e
if [ "$FAIL_EXIT" -ne 1 ]; then
  echo "[smoke] expected exit 1 for a task the verifier fails, got $FAIL_EXIT" >&2
  exit 1
fi
node "$TMP/check-results.mjs" "$TMP/fail.jsonl" sum-positive-claimed-without-fixing fail "$ROOT"

echo
echo "[smoke] step 4/4: source checkout must be unchanged"
CHECKOUT_AFTER="$(checkout_snapshot)"
if [ "$CHECKOUT_BEFORE" != "$CHECKOUT_AFTER" ]; then
  echo "[smoke] the source checkout changed during the run" >&2
  diff <(echo "$CHECKOUT_BEFORE") <(echo "$CHECKOUT_AFTER") >&2 || true
  exit 1
fi
echo "[smoke] source checkout unchanged"

echo
echo "PASS e2e-eval smoke: self-test green, 2 tasks graded by independent verifier (1 pass, 1 fail), checkout unmodified"
