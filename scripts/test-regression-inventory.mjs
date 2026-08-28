#!/usr/bin/env node
// Proves scripts/test-suites/regression-inventory.yaml assigns every
// regression candidate exactly one valid tier, and that
// scripts/regression-inventory.mjs's validator actually catches drift (not
// just "present" / "absent", but each distinct way a candidate can be
// mis-declared).
import {
  DEFAULT_MANIFEST_PATH,
  candidatesForTier,
  loadManifest,
  validateManifest,
} from './regression-inventory.mjs';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`[test-regression-inventory] ${message}`);
  }
}

function baseCandidate(overrides = {}) {
  return {
    id: 'sample-candidate',
    tier: 'nightly',
    hermetic: true,
    description: 'Sample candidate for validator unit tests.',
    script: 'scripts/regression-inventory.mjs',
    command: 'node scripts/regression-inventory.mjs validate',
    ...overrides,
  };
}

// --- The real manifest must be internally consistent. ---
const candidates = loadManifest();
assert(candidates.length > 0, 'regression-inventory.yaml must declare at least one candidate');

const realErrors = validateManifest(candidates);
assert(
  realErrors.length === 0,
  `real manifest failed validation:\n  ${realErrors.join('\n  ')}`,
);

const idCounts = new Map();
for (const candidate of candidates) {
  idCounts.set(candidate.id, (idCounts.get(candidate.id) ?? 0) + 1);
}
for (const [id, count] of idCounts) {
  assert(count === 1, `candidate "${id}" must have exactly one tier, appears ${count} times`);
}

// --- Known regression candidates must stay accounted for, not silently
// --- drop back out of the manifest.
const REQUIRED_NIGHTLY_IDS = [
  'playwright-shard-inventory-self-test',
  'workflow-mutation-oom-safe',
  'gui-open-terminal-pty-race-repro',
  'worktree-already-exists-repro',
  'e2e-regression-watch-hermetic-repro',
];
const REQUIRED_MANUAL_IDS = [
  'drift-single-op',
  'drift-thundering-herd',
  'drift-battery',
  'e2e-regression-watch-live-sweep',
  'sqljs-oom-diagnostic',
];

const nightly = candidatesForTier(candidates, 'nightly');
const manual = candidatesForTier(candidates, 'manual');
const nightlyIds = new Set(nightly.map((c) => c.id));
const manualIds = new Set(manual.map((c) => c.id));

for (const id of REQUIRED_NIGHTLY_IDS) {
  assert(nightlyIds.has(id), `expected nightly-tier candidate "${id}" is missing`);
}
for (const id of REQUIRED_MANUAL_IDS) {
  assert(manualIds.has(id), `expected manual-tier candidate "${id}" is missing`);
}

// The nightly tier is the automated tier: every candidate it runs must be
// hermetic, and no manual-only candidate (drift specs, live GitHub sweep,
// the arg-requiring sqlite diagnostic) may leak into it.
for (const candidate of nightly) {
  assert(candidate.hermetic === true, `nightly candidate "${candidate.id}" must be hermetic`);
}
for (const id of REQUIRED_MANUAL_IDS) {
  assert(!nightlyIds.has(id), `manual-only candidate "${id}" must not appear in the nightly tier`);
}

console.log(
  `[test-regression-inventory] real manifest OK: ${candidates.length} candidate(s), ${nightly.length} nightly, ${manual.length} manual.`,
);

// --- Hermetic fixtures proving the validator itself catches drift: one
// --- clean-pass case, and one case per way a candidate can be mis-declared.
const SELF_TEST_CASES = [
  {
    name: 'clean-single-candidate',
    candidates: [baseCandidate()],
    expectOk: true,
  },
  {
    name: 'duplicate-id',
    candidates: [baseCandidate(), baseCandidate()],
    expectOk: false,
  },
  {
    name: 'invalid-tier',
    candidates: [baseCandidate({ tier: 'sometimes' })],
    expectOk: false,
  },
  {
    name: 'nightly-not-hermetic',
    candidates: [baseCandidate({ tier: 'nightly', hermetic: false })],
    expectOk: false,
  },
  {
    name: 'manual-missing-reason',
    candidates: [baseCandidate({ tier: 'manual', hermetic: false, reason: undefined })],
    expectOk: false,
  },
  {
    name: 'manual-with-reason',
    candidates: [baseCandidate({ tier: 'manual', hermetic: false, reason: 'requires live auth' })],
    expectOk: true,
  },
  {
    name: 'missing-command',
    candidates: [baseCandidate({ command: undefined })],
    expectOk: false,
  },
  {
    name: 'nonexistent-script',
    candidates: [baseCandidate({ script: 'scripts/does-not-exist-anywhere.mjs' })],
    expectOk: false,
  },
];

let allSelfTestsPass = true;
for (const testCase of SELF_TEST_CASES) {
  const errors = validateManifest(testCase.candidates);
  const ok = errors.length === 0;
  const pass = ok === testCase.expectOk;
  allSelfTestsPass = allSelfTestsPass && pass;
  console.log(
    `[test-regression-inventory:self-test] ${testCase.name}: expected ${testCase.expectOk ? 'pass' : 'fail'}, got ${ok ? 'pass' : 'fail'} -- ${pass ? 'OK' : 'MISMATCH'}`,
  );
  if (!pass) {
    console.error(`  errors: ${JSON.stringify(errors)}`);
  }
}
assert(allSelfTestsPass, 'one or more validator self-test fixtures did not match their expectation');

console.log(`[test-regression-inventory] OK: manifest is ${DEFAULT_MANIFEST_PATH}`);
