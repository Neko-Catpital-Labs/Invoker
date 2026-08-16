import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import {
  readRegistry,
  quarantineInRegistry,
  restoreInRegistry,
  computeVitestExcludeArgs,
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
  const quarantined = quarantineInRegistry(empty, 'packages/ui/src/flaky.test.ts', {
    reason: 'timing race',
    source: 'manual',
    now: '2026-08-16T00:00:00Z',
  });
  assert.deepEqual(quarantined, {
    'packages/ui/src/flaky.test.ts': { reason: 'timing race', source: 'manual', quarantinedAt: '2026-08-16T00:00:00Z' },
  });
  assert.deepEqual(empty, {}, 'quarantineInRegistry must not mutate its input');

  const restored = restoreInRegistry(quarantined, 'packages/ui/src/flaky.test.ts');
  assert.deepEqual(restored, {}, 'restoring the only entry empties the registry');
  assert.deepEqual(quarantined, {
    'packages/ui/src/flaky.test.ts': { reason: 'timing race', source: 'manual', quarantinedAt: '2026-08-16T00:00:00Z' },
  }, 'restoreInRegistry must not mutate its input');

  assert.throws(
    () => restoreInRegistry({}, 'not-there.test.ts'),
    /is not currently quarantined/,
    'restoring an absent entry is an error, not a silent no-op',
  );
  assert.throws(
    () => quarantineInRegistry({}, '', { now: '2026-08-16T00:00:00Z' }),
    /test-file glob is required/,
    'an empty glob is rejected',
  );
}

// computeVitestExcludeArgs
{
  assert.deepEqual(computeVitestExcludeArgs({}), [], 'an empty registry produces no exclude args');
  assert.deepEqual(
    computeVitestExcludeArgs({
      'packages/ui/src/a.test.ts': { reason: 'r1' },
      'packages/ui/src/b.test.ts': { reason: 'r2' },
    }),
    ['--exclude', 'packages/ui/src/a.test.ts', '--exclude', 'packages/ui/src/b.test.ts'],
    'one --exclude pair per quarantined glob, in registry order',
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
    const quarantine = run(['quarantine', 'packages/ui/src/scratch.test.ts', '--reason', 'ci-only repro']);
    assert.equal(quarantine.exitCode, 0);
    assert.match(quarantine.stdout, /Quarantined "packages\/ui\/src\/scratch\.test\.ts"/);

    const list = run(['list']);
    const listed = JSON.parse(list.stdout);
    assert.ok('packages/ui/src/scratch.test.ts' in listed, 'the quarantined glob shows up in list');

    const excludeArgs = run(['exclude-args']);
    assert.equal(excludeArgs.stdout.trim(), '--exclude packages/ui/src/scratch.test.ts');

    const restore = run(['restore', 'packages/ui/src/scratch.test.ts']);
    assert.equal(restore.exitCode, 0);
    assert.match(restore.stdout, /Restored "packages\/ui\/src\/scratch\.test\.ts"/);

    const afterRestore = run(['exclude-args']);
    assert.equal(afterRestore.stdout.trim(), '', 'no excludes remain after restoring the only entry');
  } finally {
    writeFileSync(realRegistryPath, original);
  }
}

console.log('OK: flaky-test-registry.mjs');
