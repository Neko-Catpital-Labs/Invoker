#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeNextVersion } from './bump-release-version.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`not ok - ${name}`);
    console.error(err);
    process.exit(1);
  }
}

test('patch bump keeps major/minor and increments patch', () => {
  assert.equal(computeNextVersion('0.0.13', 'patch'), '0.0.14');
  assert.equal(computeNextVersion('1.2.3', 'patch'), '1.2.4');
});

test('minor bump increments minor and resets patch to 0', () => {
  assert.equal(computeNextVersion('0.0.13', 'minor'), '0.1.0');
  assert.equal(computeNextVersion('1.2.3', 'minor'), '1.3.0');
});

test('invalid version string throws', () => {
  assert.throws(() => computeNextVersion('not-a-version', 'patch'));
  assert.throws(() => computeNextVersion('1.2', 'patch'));
});

test('invalid kind throws', () => {
  assert.throws(() => computeNextVersion('1.2.3', 'major'));
});

test('--dry-run prints the computed version and writes nothing', () => {
  const before = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  const output = execFileSync(
    process.execPath,
    [join(root, 'scripts/bump-release-version.mjs'), '--type', 'patch', '--dry-run', '--from', '0.0.13'],
    { encoding: 'utf8' },
  ).trim();
  assert.equal(output, '0.0.14');
  const after = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  assert.equal(after, before);
});

console.log('all tests passed');
process.exit(0);
