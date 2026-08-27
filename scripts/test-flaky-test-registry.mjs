import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import {
  readRegistry,
  quarantineInRegistry,
  restoreInRegistry,
  computeVitestExcludeArgs,
  computeSuiteExcludeList,
} from './flaky-test-registry.mjs';

// readRegistry
{
  assert.deepEqual(readRegistry(''), {}, 'empty file reads as an empty registry');
  assert.deepEqual(readRegistry('{}'), {}, 'empty object round-trips');
  assert.deepEqual(
    readRegistry('{"a.test.ts": {"reason": "r"}}'),
    { 'a.test.ts': { reason: 'r' } },
    'a populated registry parses',
  );
  assert.throws(() => readRegistry('[]'), /must be a JSON object/, 'an array registry is rejected');
}

// quarantineInRegistry / restoreInRegistry
{
  const empty = {};
  const quarantined = quarantineInRegistry(empty, '**/src/__tests__/flaky.test.ts', {
    reason: 'timing race',
    source: 'manual',
    now: '2026-08-16T00:00:00Z',
  });
  assert.deepEqual(quarantined, {
    '**/src/__tests__/flaky.test.ts': {
      reason: 'timing race',
      source: 'manual',
      quarantinedAt: '2026-08-16T00:00:00Z',
      kind: 'vitest-file',
    },
  }, 'kind defaults to vitest-file when omitted');
  assert.deepEqual(empty, {}, 'quarantineInRegistry must not mutate its input');

  const restored = restoreInRegistry(quarantined, '**/src/__tests__/flaky.test.ts');
  assert.deepEqual(restored, {}, 'restoring the only entry empties the registry');
  assert.deepEqual(quarantined, {
    '**/src/__tests__/flaky.test.ts': {
      reason: 'timing race',
      source: 'manual',
      quarantinedAt: '2026-08-16T00:00:00Z',
      kind: 'vitest-file',
    },
  }, 'restoreInRegistry must not mutate its input');

  assert.throws(
    () => restoreInRegistry({}, 'not-there.test.ts'),
    /is not currently quarantined/,
    'restoring an absent entry is an error, not a silent no-op',
  );
  assert.throws(
    () => quarantineInRegistry({}, '', { now: '2026-08-16T00:00:00Z' }),
    /A quarantine target .* is required/,
    'an empty target is rejected',
  );

  const suiteQuarantined = quarantineInRegistry({}, 'optional/40-playwright-app.sh', {
    reason: 'batch-only flake',
    source: 'manual',
    now: '2026-08-16T00:00:00Z',
    kind: 'suite',
  });
  assert.deepEqual(suiteQuarantined, {
    'optional/40-playwright-app.sh': {
      reason: 'batch-only flake',
      source: 'manual',
      quarantinedAt: '2026-08-16T00:00:00Z',
      kind: 'suite',
    },
  }, 'kind: suite is stored as given');

  assert.throws(
    () => quarantineInRegistry({}, 'x.test.ts', { now: '2026-08-16T00:00:00Z', kind: 'bogus' }),
    /Unknown kind "bogus"/,
    'an invalid kind is rejected',
  );

  // Reproduces a real bug: vitest resolves --exclude relative to each
  // package's own cwd, not the repo root, so a repo-root-relative glob
  // silently excludes nothing. Confirmed live before this guard existed:
  // `pnpm --filter @invoker/ui test -- --exclude "packages/ui/src/__tests__/task-panel-error.test.tsx"`
  // still ran that file. The guard rejects that shape at write time instead
  // of letting it ship as a no-op quarantine entry.
  assert.throws(
    () => quarantineInRegistry({}, 'packages/ui/src/__tests__/flaky.test.ts', { now: '2026-08-16T00:00:00Z' }),
    /must start with "\*\*\/"/,
    'a repo-root-relative glob (no wildcard prefix) is rejected, not silently accepted as a no-op',
  );
}

// computeVitestExcludeArgs / computeSuiteExcludeList
{
  assert.deepEqual(computeVitestExcludeArgs({}), [], 'an empty registry produces no exclude args');
  assert.deepEqual(
    computeVitestExcludeArgs({
      '**/src/__tests__/a.test.ts': { reason: 'r1' },
      '**/src/__tests__/b.test.ts': { reason: 'r2', kind: 'vitest-file' },
    }),
    ['--exclude', '**/src/__tests__/a.test.ts', '--exclude', '**/src/__tests__/b.test.ts'],
    'one --exclude pair per quarantined vitest-file glob, in registry order (kind omitted or explicit)',
  );
  assert.deepEqual(
    computeVitestExcludeArgs({
      '**/src/__tests__/a.test.ts': { reason: 'r1' },
      'optional/40-playwright-app.sh': { reason: 'r2', kind: 'suite' },
    }),
    ['--exclude', '**/src/__tests__/a.test.ts'],
    'suite-kind entries never leak into vitest exclude args',
  );

  assert.deepEqual(computeSuiteExcludeList({}), [], 'an empty registry produces no suite excludes');
  assert.deepEqual(
    computeSuiteExcludeList({
      '**/src/__tests__/a.test.ts': { reason: 'r1', kind: 'vitest-file' },
      'optional/40-playwright-app.sh': { reason: 'r2', kind: 'suite' },
      'required/18-start-running-mece-repros.sh': { reason: 'r3', kind: 'suite' },
    }),
    ['optional/40-playwright-app.sh', 'required/18-start-running-mece-repros.sh'],
    'only suite-kind entries are returned, vitest-file entries are excluded',
  );
}

// CLI surface. The script resolves REGISTRY_PATH relative to its own file
// location (the real repo registry) -- save and restore its content around
// this test rather than pointing it at a scratch path.
{
  const scriptPath = join(import.meta.dirname, 'flaky-test-registry.mjs');

  function run(args, env = {}) {
    try {
      const stdout = execFileSync('node', [scriptPath, ...args], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
      });
      return { exitCode: 0, stdout };
    } catch (err) {
      return { exitCode: err.status, stdout: err.stdout, stderr: err.stderr };
    }
  }

  const realRegistryPath = join(import.meta.dirname, 'flaky-test-registry.json');
  const original = readFileSync(realRegistryPath, 'utf8');
  try {
    const quarantine = run(['quarantine', '**/src/__tests__/scratch.test.ts', '--reason', 'ci-only repro']);
    assert.equal(quarantine.exitCode, 0);
    assert.match(quarantine.stdout, /Quarantined "\*\*\/src\/__tests__\/scratch\.test\.ts"/);

    const list = run(['list']);
    const listed = JSON.parse(list.stdout);
    assert.ok('**/src/__tests__/scratch.test.ts' in listed, 'the quarantined glob shows up in list');

    const excludeArgs = run(['exclude-args']);
    assert.equal(excludeArgs.stdout.trim(), '--exclude **/src/__tests__/scratch.test.ts');

    const restore = run(['restore', '**/src/__tests__/scratch.test.ts']);
    assert.equal(restore.exitCode, 0);
    assert.match(restore.stdout, /Restored "\*\*\/src\/__tests__\/scratch\.test\.ts"/);

    const afterRestore = run(['exclude-args']);
    assert.equal(afterRestore.stdout.trim(), '', 'no excludes remain after restoring the only entry');

    const quarantineSuite = run([
      'quarantine', 'optional/99-test-only.sh', '--reason', 'batch-only flake', '--kind', 'suite',
    ]);
    assert.equal(quarantineSuite.exitCode, 0);
    assert.match(quarantineSuite.stdout, /Quarantined "optional\/99-test-only\.sh"/);

    const suiteExcludeEnv = run(['exclude-suites-env']);
    assert.equal(suiteExcludeEnv.stdout.trim(), 'optional/99-test-only.sh');

    const excludeArgsWithSuite = run(['exclude-args']);
    assert.equal(
      excludeArgsWithSuite.stdout.trim(),
      '',
      'a suite-kind entry must never appear in vitest exclude-args',
    );

    const restoreSuite = run(['restore', 'optional/99-test-only.sh']);
    assert.equal(restoreSuite.exitCode, 0);

    const afterRestoreSuite = run(['exclude-suites-env']);
    assert.equal(afterRestoreSuite.stdout.trim(), '', 'no suite excludes remain after restoring the only entry');
  } finally {
    writeFileSync(realRegistryPath, original);
  }
}

console.log('OK: flaky-test-registry.mjs');
