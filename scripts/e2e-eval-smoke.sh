#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-e2e-eval-smoke.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

MANIFEST="$WORK_DIR/smoke-manifest.json"
RESULTS="$WORK_DIR/results.jsonl"

checkout_snapshot() {
  git -C "$ROOT" rev-parse HEAD
  git -C "$ROOT" status --porcelain=v1
}

CHECKOUT_BEFORE="$(checkout_snapshot)"

echo "== e2e-eval-runner self-test =="
node scripts/e2e-eval-runner.mjs --self-test

echo
echo "== building the smoke manifest outside the source checkout =="
node - "$MANIFEST" <<'NODE'
const { writeFileSync } = require('node:fs');

const brokenSum = [
  "function sum(a, b) {",
  "  return a - b;",
  "}",
  "module.exports = { sum };",
  "",
].join("\n");

const fixedSum = brokenSum.replace("a - b", "a + b");

const sumTest = [
  "const assert = require('node:assert/strict');",
  "const { sum } = require('./sum.js');",
  "assert.equal(sum(2, 2), 4);",
  "assert.equal(sum(10, 5), 15);",
  "assert.equal(sum(-3, 3), 0);",
  "console.log('sum.test.js: 3 assertions passed');",
  "",
].join("\n");

const grader = [
  "set -euo pipefail",
  'cd "$EVAL_WORKSPACE"',
  "node sum.test.js",
  'echo "verifier: sum.test.js passed against the final workspace state"',
  "",
].join("\n");

const fixture = { files: { "sum.js": brokenSum, "sum.test.js": sumTest } };
const verify = {
  run: ["bash", "-c", 'bash "$EVAL_VERIFIER_DIR/grade.sh"'],
  timeoutMs: 60000,
  files: { "grade.sh": grader },
};

const manifest = {
  version: 1,
  defaults: { model: "claude-opus-5", budgetUsd: 0.25, timeoutMs: 60000 },
  tasks: [
    {
      id: "repairs-the-failing-test",
      prompt: "sum.js returns the difference instead of the sum. Fix it so sum.test.js passes.",
      fixture,
      solve: {
        run: [
          "bash",
          "-c",
          "node -e \"const fs=require('node:fs');fs.writeFileSync('sum.js',fs.readFileSync('sum.js','utf8').replace('a - b','a + b'))\"; echo 'solver: patched sum.js'",
        ],
      },
      verify,
      solution: { files: { "sum.js": fixedSum } },
    },
    {
      id: "claims-success-without-repairing",
      prompt: "sum.js returns the difference instead of the sum. Fix it so sum.test.js passes.",
      fixture,
      solve: { run: ["bash", "-c", "echo 'solver: done, all tests pass'; exit 0"] },
      verify,
      solution: { files: { "sum.js": fixedSum } },
    },
  ],
};

writeFileSync(process.argv[2], `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${manifest.tasks.length}-task manifest to ${process.argv[2]}`);
NODE

echo
echo "== running the smoke manifest =="
node scripts/e2e-eval-runner.mjs --manifest "$MANIFEST" --results "$RESULTS" --no-gate

echo
echo "== asserting the structured result rows =="
node - "$RESULTS" <<'NODE'
const { readFileSync } = require('node:fs');
const { relative } = require('node:path');

const rows = readFileSync(process.argv[2], 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line));

const failures = [];
const expect = (label, condition, detail) => {
  if (!condition) failures.push(detail ? `${label} (${detail})` : label);
};

expect('two result rows were emitted', rows.length === 2, `got ${rows.length}`);

const byId = new Map(rows.map((row) => [row.taskId, row]));
const repaired = byId.get('repairs-the-failing-test');
const claimed = byId.get('claims-success-without-repairing');

expect('the repairing task produced a row', Boolean(repaired));
expect('the claiming task produced a row', Boolean(claimed));

if (repaired && claimed) {
  expect('a real repair is graded pass', repaired.verdict === 'pass', `got ${repaired.verdict}`);
  expect('the verifier exited 0 on the repair', repaired.verifier.exitCode === 0, `got ${repaired.verifier.exitCode}`);
  expect(
    'the verifier emitted its own independent output',
    repaired.verifier.stdout.includes('verifier: sum.test.js passed against the final workspace state'),
    JSON.stringify(repaired.verifier.stdout),
  );
  expect(
    'the verifier ran the fixture test itself',
    repaired.verifier.stdout.includes('sum.test.js: 3 assertions passed'),
  );
  expect('the repair mutated the disposable workspace', repaired.finalState.mutated === true);

  expect('a solver claiming success is graded fail', claimed.verdict === 'fail', `got ${claimed.verdict}`);
  expect('that solver did report success', claimed.solverReportedSuccess === true);
  expect('that solver exited 0', claimed.solver.exitCode === 0, `got ${claimed.solver.exitCode}`);
  expect('the divergence is recorded', claimed.independenceDivergence === true);
  expect('the unrepaired workspace was left unmutated', claimed.finalState.mutated === false);
  expect(
    'the verifier explained the failure independently',
    claimed.verifier.stderr.includes('AssertionError') || claimed.verifier.stderr.includes('sum.test.js'),
    JSON.stringify(claimed.verifier.stderr.slice(0, 200)),
  );
}

for (const row of rows) {
  expect(`${row.taskId} declares the result schema version`, row.schemaVersion === 1);
  expect(`${row.taskId} is graded by the verifier alone`, row.gradedBy === 'independent-verifier-exit-code');
  expect(`${row.taskId} records an explicit model`, row.model === 'claude-opus-5', row.model);
  expect(`${row.taskId} records an explicit budget`, row.budgetUsd === 0.25, String(row.budgetUsd));
  expect(`${row.taskId} records a final-state digest`, /^[0-9a-f]{64}$/.test(row.finalState.digest));
  expect(`${row.taskId} kept the grader private`, row.verifierFiles.includes('grade.sh'));
  expect(
    `${row.taskId} kept the grader outside the workspace`,
    relative(row.paths.workspace, row.paths.verifierDir).startsWith('..'),
  );
  expect(`${row.taskId} never wrote its reference solution`, row.referenceSolution.writtenToWorkspace === false);
  expect(`${row.taskId} recorded a reference solution digest`, typeof row.referenceSolution.digest === 'string');
  expect(`${row.taskId} used a disposable root`, row.paths.root.includes('invoker-e2e-eval-'));
}

console.log('--- structured result row (repairs-the-failing-test) ---');
console.log(JSON.stringify(byId.get('repairs-the-failing-test'), null, 2));

if (failures.length > 0) {
  console.error('FAIL e2e-eval-smoke result assertions');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`smoke result assertions: ${rows.length} rows verified`);
NODE

CHECKOUT_AFTER="$(checkout_snapshot)"
if [ "$CHECKOUT_BEFORE" != "$CHECKOUT_AFTER" ]; then
  echo "The eval smoke mutated the source checkout." >&2
  diff -u <(printf '%s\n' "$CHECKOUT_BEFORE") <(printf '%s\n' "$CHECKOUT_AFTER") >&2 || true
  exit 1
fi

if [ -e "$ROOT/workspace" ] || [ -e "$ROOT/verifier" ]; then
  echo "The eval smoke leaked a fixture directory into the source checkout." >&2
  exit 1
fi

echo
echo "PASS e2e-eval-smoke: self-test plus 2 smoke tasks graded by an independent verifier; source checkout unchanged"
