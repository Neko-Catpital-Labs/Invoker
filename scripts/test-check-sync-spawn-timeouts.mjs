#!/usr/bin/env node
import assert from 'node:assert/strict';
import { collectUnboundedSyncSpawns, isCheckedPath, resolveBase } from './check-sync-spawn-timeouts.mjs';

const owner = 'packages/execution-engine/src/pr-authoring.ts';

function addedFile(lines, addedLineNumbers = lines.map((_, index) => index + 1)) {
  const hunks = addedLineNumbers.map((lineNumber) => [`@@ -0,0 +${lineNumber} @@`, `+${lines[lineNumber - 1]}`].join('\n'));
  return [`diff --git a/${owner} b/${owner}`, `+++ b/${owner}`, ...hunks, ''].join('\n');
}

function check(lines, options = {}) {
  const filePath = options.path ?? owner;
  const text = `${lines.join('\n')}\n`;
  const diff = addedFile(lines, options.added).replaceAll(owner, filePath);
  return collectUnboundedSyncSpawns(diff, () => text);
}

const importLine = "import { spawnSync, execFileSync, execSync } from 'node:child_process';";

assert.equal(check([importLine, "const result = spawnSync(process.execPath, [validatorPath], { cwd, encoding: 'utf8' });"]).length, 1,
  'the #12115 freeze shape is flagged');
assert.equal(check([importLine, "spawnSync(process.execPath, [validatorPath], { cwd, timeout: 60_000 });"]).length, 0,
  'a positive inline timeout passes');
assert.equal(check([importLine, 'execFileSync(', "  'ps',", "  ['-p', String(pid)],", "  { encoding: 'utf8', timeout: 5_000 },", ');']).length, 0,
  'a multi-line call with a positive timeout passes');
assert.equal(check([importLine, "execSync('git status', { timeout: 0 });"]).length, 1, 'timeout: 0 is unbounded and flagged');
assert.equal(check([importLine, "execSync('git status', { env: { timeout: 5 } });"]).length, 1, 'a nested timeout does not count');
assert.equal(check([importLine, "execSync('git status');", 'const later = { timeout: 1 };']).length, 1, 'a timeout outside the call does not count');
assert.equal(check([importLine, 'spawnSync(cmd, args, options);']).length, 1, 'an options variable cannot prove a timeout');
assert.equal(check([importLine, 'spawnSync(cmd, args, { ...defaults });']).length, 1, 'a spread cannot prove a timeout');
assert.equal(check([importLine, 'const LIMIT = 60 * 1000;', "execSync('ls', { timeout: LIMIT });"]).length, 0,
  'a const numeric expression passes');
assert.equal(check([importLine, 'const timeout = 30_000;', "execSync('ls', { timeout });"]).length, 0, 'shorthand to a positive const passes');
assert.equal(check([importLine, "execFileSync('ls', { timeout: 2_000 });"]).length, 0, 'execFileSync with options as the second argument passes');

assert.equal(check(["import { spawnSync as run } from 'node:child_process';", "run('ls', []);"]).length, 1, 'an aliased named import is flagged');
assert.equal(check(["import * as cp from 'child_process';", "cp.execSync('ls');"]).length, 1, 'a namespace import call is flagged');
assert.equal(check(["const { execFileSync: ef } = require('node:child_process');", "ef('ls', []);"]).length, 1, 'a require destructure alias is flagged');
assert.equal(check(["const cp = require('node:child_process');", "cp.spawnSync('ls', [], {});"]).length, 1, 'a required module object call is flagged');

assert.equal(check([importLine, "const note = 'spawnSync(cmd) is blocking';", 'const tpl = `execSync(${cmd})`;', '// execFileSync(cmd)']).length, 0,
  'text in strings, template literals, and comments is not a call');
assert.equal(check(["function spawnSync(cmd) { return cmd; }", 'spawnSync(1);']).length, 0, 'a local function with the same name is not child_process');

assert.equal(check([importLine, "execSync('ls');", "execSync('pwd');"], { added: [3] }).length, 1, 'only calls on added lines are checked');
assert.equal(check([importLine, "execSync('ls');"], { path: 'packages/app/src/__tests__/x.test.ts' }).length, 0, 'tests are not checked');
assert.equal(check([importLine, "execSync('ls');"], { path: 'packages/cli/src/onboarding.ts' }).length, 0, 'the interactive command-line package is not checked');
assert.equal(check([importLine, "execSync('ls');"], { path: 'scripts/tool.mjs' }).length, 0, 'repo scripts are not checked');

const unreadable = collectUnboundedSyncSpawns(addedFile(['execSync(cmd);']), () => { throw new Error('missing'); });
assert.equal(unreadable.length, 1, 'an unreadable post-image is reported, never passed');
assert.match(unreadable[0].reason, /^unchecked:/);

assert.equal(isCheckedPath('packages/app/src/main.ts'), true);
assert.equal(isCheckedPath('packages/app/e2e/flow.spec.ts'), false);

assert.deepEqual(resolveBase({ explicitBase: 'origin/master', refExists: () => false }), { base: 'origin/master' });
assert.deepEqual(resolveBase({ explicitBase: '', refExists: (ref) => ref === 'origin/main' }), { base: 'origin/main' });
assert.match(resolveBase({ explicitBase: '', refExists: () => false }).unchecked, /no base ref/);

console.log('check-sync-spawn-timeouts tests passed');
