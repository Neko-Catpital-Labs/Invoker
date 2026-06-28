#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  evaluateRollout,
  parseAuthorList,
  parseBooleanSwitch,
  shouldEnforcePrBody,
} from './pr-body-rollout.mjs';

assert.equal(parseBooleanSwitch('true'), true);
assert.equal(parseBooleanSwitch('all'), true);
assert.equal(parseBooleanSwitch('everyone'), true);
assert.equal(parseBooleanSwitch('false'), false);
assert.equal(parseBooleanSwitch(''), false);

assert.deepEqual(parseAuthorList('EdbertChan,octocat someone'), ['edbertchan', 'octocat', 'someone']);
assert.deepEqual(parseAuthorList(''), []);

assert.equal(shouldEnforcePrBody({ author: 'EdbertChan', enforceAll: 'false', enforcedAuthors: 'EdbertChan' }), true);
assert.equal(shouldEnforcePrBody({ author: 'edbertchan', enforceAll: '', enforcedAuthors: 'EdbertChan' }), true);
assert.equal(shouldEnforcePrBody({ author: 'octocat', enforceAll: 'false', enforcedAuthors: 'EdbertChan' }), false);
assert.equal(shouldEnforcePrBody({ author: 'octocat', enforceAll: 'true', enforcedAuthors: '' }), true);
assert.equal(shouldEnforcePrBody({ author: '', enforceAll: 'true', enforcedAuthors: '' }), false);

assert.deepEqual(evaluateRollout({ author: 'EdbertChan', enforceAll: 'false', enforcedAuthors: 'EdbertChan' }), {
  enabled: true,
  author: 'EdbertChan',
  enforceAll: false,
  enforcedAuthors: ['edbertchan'],
});

const outputDir = mkdtempSync(join(tmpdir(), 'pr-body-rollout-'));
const outputFile = join(outputDir, 'github-output');
try {
  const result = spawnSync(process.execPath, [
    'scripts/pr-body-rollout.mjs',
    '--author',
    'octocat',
    '--enforce-all',
    'false',
    '--authors',
    'EdbertChan',
  ], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, GITHUB_OUTPUT: outputFile },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).enabled, false);
  assert.match(readFileSync(outputFile, 'utf8'), /^enabled=false$/m);
  assert.match(readFileSync(outputFile, 'utf8'), /^author=octocat$/m);
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}

console.log('OK: PR body rollout checks passed');
