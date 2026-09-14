#!/usr/bin/env node
// Reproduces the CI "Verify Playwright shard inventory" step locally so the
// playwright / N-of-9 shard regression cannot recur silently. It asserts that
// every CI-owned packages/app/e2e spec -- including specs nested below the
// top-level e2e directory, e.g. e2e/drift/*.spec.ts -- is assigned to exactly
// one Playwright shard: no spec missing from the matrix, no spec listed that
// does not exist, no spec assigned to more than one shard, and every
// manual-only allowlist entry still exists.
//
// The playwright shards first went red at
// d19a0f4af741226c3edb9509e2768529bf97fef9 because specs were listed in
// more than one matrix entry. Duplicate assignment fails this guard before
// Playwright runs, so every CI-owned spec must have one shard owner.
//
// The manual real-Claude repro and the UI/backend drift harness
// (packages/app/e2e/drift/*.spec.ts -- "not a green-required CI gate" per its
// own file header) intentionally stay out of CI. Keep them explicit here so
// future unassigned deterministic specs, nested or not, still fail the guard.
//
// Usage:
//   node scripts/repro/repro-ci-playwright-shard-inventory.mjs [workflow.yml] [e2eDir]
//   node scripts/repro/repro-ci-playwright-shard-inventory.mjs --self-test
// Exit 0 when the inventory is consistent, 1 when drift is detected.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';
import YAML from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtureRoot = resolve(repoRoot, 'scripts/repro/fixtures/playwright-shard-inventory');

const MANUAL_ONLY_SPECS = new Set([
  // Capture-only visual proof driven by scripts/ui-visual-proof.sh with
  // CAPTURE_MODE; normal CI shards should not run the full onboarding capture.
  'onboarding-cli-visual-proof.spec.ts',
  // This spec intentionally drives the real `claude` binary and depends on
  // live auth/UI state, so it stays opt-in instead of becoming a CI shard.
  'planning-terminal-chat-tmux-toggle-real-claude-repro.spec.ts',
  // UI/backend drift harness: one check per packages/app/e2e/drift's own
  // scenario-catalog.ts entry, some of which fail until their underlying
  // drift bug is fixed. Diagnostic harness, not a green-required CI gate.
  'drift/drift-thundering-herd.spec.ts',
  'drift/drift-single-op.spec.ts',
  'drift/drift-battery.spec.ts',
]);

function shardFiles(job) {
  if (!job?.strategy?.matrix?.include) return [];
  return job.strategy.matrix.include.flatMap((shard) =>
    String(shard.files ?? '').trim().split(/\s+/).filter(Boolean),
  );
}

function discoverSpecFiles(e2eDir) {
  const results = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.spec.ts')) {
        results.push(relative(e2eDir, fullPath).split(sep).join('/'));
      }
    }
  };
  walk(e2eDir);
  return results.sort();
}

function checkInventory({ workflowPath, e2eDir, manualOnlySpecs }) {
  const workflow = YAML.parse(readFileSync(workflowPath, 'utf8'));
  const listed = [
    ...shardFiles(workflow.jobs?.playwright),
    ...shardFiles(workflow.jobs?.['playwright-nightly-perf']),
  ];
  const allDiscovered = discoverSpecFiles(e2eDir);
  const allDiscoveredSet = new Set(allDiscovered);
  const discovered = allDiscovered
    .filter((file) => !manualOnlySpecs.has(file))
    .map((file) => `e2e/${file}`)
    .sort();

  const listedSet = new Set(listed);
  const discoveredSet = new Set(discovered);
  const manualListed = [...manualOnlySpecs]
    .map((file) => `e2e/${file}`)
    .filter((file) => listedSet.has(file));
  const manualListedSet = new Set(manualListed);
  const manualMissing = [...manualOnlySpecs]
    .filter((file) => !allDiscoveredSet.has(file))
    .map((file) => `e2e/${file}`);
  const missing = discovered.filter((file) => !listedSet.has(file));
  const extra = listed.filter((file) => !discoveredSet.has(file) && !manualListedSet.has(file));
  const duplicates = [...new Set(listed.filter((file, index) => listed.indexOf(file) !== index))];

  const ok = !(manualMissing.length || manualListed.length || missing.length || extra.length || duplicates.length);
  return {
    ok,
    manualMissing,
    manualListed,
    missing,
    extra,
    duplicates,
    discoveredCount: discovered.length,
    manualCount: manualOnlySpecs.size,
  };
}

function reportResult(result, label) {
  const prefix = label ? `[repro-ci-playwright-shard-inventory:${label}]` : '[repro-ci-playwright-shard-inventory]';
  if (!result.ok) {
    console.error(`${prefix} Playwright shard inventory drift detected.`);
    if (result.manualMissing.length) console.error(`  Manual spec allowlist entries do not exist: ${result.manualMissing.join(', ')}`);
    if (result.manualListed.length) console.error(`  Manual-only specs assigned to shards: ${result.manualListed.join(', ')}`);
    if (result.missing.length) console.error(`  Missing from shards: ${result.missing.join(', ')}`);
    if (result.extra.length) console.error(`  Extra in shards: ${result.extra.join(', ')}`);
    if (result.duplicates.length) console.error(`  Duplicate shard entries: ${result.duplicates.join(', ')}`);
    return;
  }
  console.log(
    `${prefix} OK: ${result.discoveredCount} CI-owned spec files each assigned to exactly one shard; ${result.manualCount} manual-only spec(s) accounted for.`,
  );
}

// Hermetic fixtures proving the accounting itself: a nested spec that is
// missing from every shard and not manual-only must fail the guard; plain
// top-level ownership and nested manual-only specs must keep passing.
const SELF_TEST_CASES = [
  { name: 'nested-omission', manualOnlySpecs: new Set(), expectOk: false },
  { name: 'top-level-ownership', manualOnlySpecs: new Set(), expectOk: true },
  { name: 'manual-only', manualOnlySpecs: new Set(['manual/manual-nested.spec.ts']), expectOk: true },
];

function runSelfTest() {
  let allPass = true;
  for (const testCase of SELF_TEST_CASES) {
    const caseDir = resolve(fixtureRoot, testCase.name);
    const result = checkInventory({
      workflowPath: resolve(caseDir, 'workflow.yml'),
      e2eDir: resolve(caseDir, 'e2e'),
      manualOnlySpecs: testCase.manualOnlySpecs,
    });
    const pass = result.ok === testCase.expectOk;
    allPass = allPass && pass;
    console.log(
      `[repro-ci-playwright-shard-inventory:self-test] ${testCase.name}: expected ${testCase.expectOk ? 'pass' : 'fail'}, got ${result.ok ? 'pass' : 'fail'} -- ${pass ? 'OK' : 'MISMATCH'}`,
    );
    if (!pass) reportResult(result, testCase.name);
  }
  return allPass;
}

function main() {
  if (process.argv.includes('--self-test')) {
    process.exit(runSelfTest() ? 0 : 1);
  }

  const workflowPath = resolve(repoRoot, process.argv[2] ?? '.github/workflows/ci.yml');
  const e2eDir = resolve(repoRoot, process.argv[3] ?? 'packages/app/e2e');
  const result = checkInventory({ workflowPath, e2eDir, manualOnlySpecs: MANUAL_ONLY_SPECS });
  reportResult(result);
  process.exit(result.ok ? 0 : 1);
}

main();
