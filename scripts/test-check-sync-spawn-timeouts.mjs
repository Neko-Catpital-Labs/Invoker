#!/usr/bin/env node
import assert from 'node:assert/strict';
import { collectUnboundedSyncSpawns, isCheckedPath } from './check-sync-spawn-timeouts.mjs';

const diffFor = (filePath, lines) => [
  `diff --git a/${filePath} b/${filePath}`,
  `+++ b/${filePath}`,
  `@@ -0,0 +1,${lines.length} @@`,
  ...lines.map((line) => `+${line}`),
  '',
].join('\n');

const check = (filePath, lines) => collectUnboundedSyncSpawns(diffFor(filePath, lines), () => `${lines.join('\n')}\n`);

const owner = 'packages/execution-engine/src/pr-authoring.ts';

assert.equal(check(owner, [
  "const result = spawnSync(process.execPath, [validatorPath], { cwd, encoding: 'utf8' });",
]).length, 1, 'the #12115 freeze shape is flagged');

assert.equal(check(owner, [
  "const result = spawnSync(process.execPath, [validatorPath], { cwd, encoding: 'utf8', timeout: 60_000 });",
]).length, 0, 'an inline timeout passes');

assert.equal(check(owner, [
  'const out = execFileSync(',
  "  'ps',",
  "  ['-p', String(pid)],",
  "  { encoding: 'utf8', timeout: 5_000 },",
  ');',
]).length, 0, 'a timeout on a later line of the same call passes');

assert.equal(check(owner, [
  "execSync('git status');",
  "const later = { timeout: 1 };",
]).length, 1, 'a timeout outside the call does not count');

assert.equal(check(owner, ['spawnSync(cmd, args, options);']).length, 1, 'an options variable must carry the timeout inline');

assert.equal(check('packages/app/src/__tests__/x.test.ts', ['spawnSync(cmd);']).length, 0, 'tests are not checked');
assert.equal(check('packages/cli/src/onboarding.ts', ['spawnSync(cmd);']).length, 0, 'the interactive CLI package is not checked');
assert.equal(check('scripts/tool.mjs', ['spawnSync(cmd);']).length, 0, 'repo scripts are not checked');

const unreadable = collectUnboundedSyncSpawns(diffFor(owner, ['spawnSync(cmd);']), () => { throw new Error('missing'); });
assert.equal(unreadable.length, 1, 'an unreadable post-image is reported, never passed');
assert.match(unreadable[0].reason, /^unchecked:/);

assert.equal(isCheckedPath('packages/app/src/main.ts'), true);
assert.equal(isCheckedPath('packages/app/e2e/flow.spec.ts'), false);

console.log('check-sync-spawn-timeouts tests passed');
