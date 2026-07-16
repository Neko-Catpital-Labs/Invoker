#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAddedCommentViolations } from './check-added-comments.mjs';

const scriptPath = fileURLToPath(new URL('./check-added-comments.mjs', import.meta.url));

{
  const diff = [
    'diff --git a/packages/core/src/thing.ts b/packages/core/src/thing.ts',
    '+++ b/packages/core/src/thing.ts',
    '@@ -0,0 +1,4 @@',
    '+const url = "https://example.com";',
    '+const block = "/* text */";',
    '+// @ts-expect-error external type drift',
    '+const value = true; // explains the obvious',
    '',
  ].join('\n');
  const violations = collectAddedCommentViolations(diff);
  assert.deepEqual(violations.map((violation) => `${violation.path}:${violation.line}`), ['packages/core/src/thing.ts:4']);
}

{
  const diff = [
    'diff --git a/scripts/run.sh b/scripts/run.sh',
    '+++ b/scripts/run.sh',
    '@@ -0,0 +1,3 @@',
    '+#!/usr/bin/env bash',
    '+echo "# not a comment"',
    '+value=1 # noisy note',
    '',
  ].join('\n');
  const violations = collectAddedCommentViolations(diff);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].line, 3);
}
{
  const diff = [
    'diff --git a/packages/core/src/license.ts b/packages/core/src/license.ts',
    '+++ b/packages/core/src/license.ts',
    '@@ -0,0 +1,4 @@',
    '+/*',
    '+ * SPDX-License-Identifier: MIT',
    '+ */',
    '+export const value = 1;',
    '',
  ].join('\n');
  assert.equal(collectAddedCommentViolations(diff).length, 0);
}


{
  const diff = [
    'diff --git a/packages/core/src/thing.test.ts b/packages/core/src/thing.test.ts',
    '+++ b/packages/core/src/thing.test.ts',
    '@@ -0,0 +1 @@',
    '+const value = true; // test fixture note',
    '',
  ].join('\n');
  assert.equal(collectAddedCommentViolations(diff).length, 0);
}
{
  const diff = [
    'diff --git a/scripts/run.sh b/scripts/run.sh',
    '+++ b/scripts/run.sh',
    '@@ -0,0 +1,2 @@',
    '+name=${path##*/}',
    '+echo "$name"',
    '',
  ].join('\n');
  assert.equal(collectAddedCommentViolations(diff).length, 0);
}


{
  const root = mkdtempSync(path.join(tmpdir(), 'invoker-comment-check-'));
  try {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root, stdio: 'ignore' });
    mkdirSync(path.join(root, 'packages/core/src'), { recursive: true });
    writeFileSync(path.join(root, 'packages/core/src/thing.ts'), 'export const value = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: root, stdio: 'ignore' });
    writeFileSync(path.join(root, 'packages/core/src/thing.ts'), 'export const value = 1; // noisy note\n');
    assert.throws(
      () => execFileSync(process.execPath, [scriptPath, '--root', root, '--base', 'HEAD'], { encoding: 'utf8' }),
      /newly-added comment/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Temp git case: a diff larger than Node's 1MB execFileSync default still runs.
// `git diff` streams every changed file back before any path filtering, so a
// large lockfile update used to kill the checker with ENOBUFS.
{
  const root = mkdtempSync(path.join(tmpdir(), 'invoker-added-comments-big-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root, stdio: 'ignore' });
    writeFileSync(path.join(root, 'seed.txt'), 'seed\n');
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: root, stdio: 'ignore' });

    let lockfile = '';
    for (let index = 0; index < 60000; index += 1) {
      lockfile += `  '/some-package-${index}@1.0.0': {}\n`;
    }
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), lockfile);
    writeFileSync(path.join(root, 'package.json'), '{\n  "name": "probe"\n}\n');
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'big dependency update'], { cwd: root, stdio: 'ignore' });

    const output = execFileSync(process.execPath, [scriptPath, '--root', root, '--base', 'master'], { encoding: 'utf8' });
    assert.match(output, /Checked added source lines; no disallowed comments found\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('ok added comment checker');
