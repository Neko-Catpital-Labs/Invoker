#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseUnifiedDiff,
  collectDiffAtomicityFindings,
  formatDiffAtomicityFindings,
  lintDiffAtomicityForGit,
} from './lint-pr-diff-atomicity.mjs';

const scriptPath = fileURLToPath(new URL('./lint-pr-diff-atomicity.mjs', import.meta.url));

function diff(lines) {
  return `${lines.join('\n')}\n`;
}

function kinds(findings) {
  return findings.map((finding) => finding.kind).sort();
}

// Case 1: a clean, single-area source + test change is atomic.
{
  const text = diff([
    'diff --git a/packages/core/src/add.ts b/packages/core/src/add.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/packages/core/src/add.ts',
    '@@ -0,0 +1,3 @@',
    '+export function add(a: number, b: number): number {',
    '+  return a + b;',
    '+}',
    'diff --git a/packages/core/src/add.test.ts b/packages/core/src/add.test.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/packages/core/src/add.test.ts',
    '@@ -0,0 +1,3 @@',
    "+import { add } from './add';",
    "+import { it } from 'vitest';",
    "+it('adds', () => { add(1, 2); });",
  ]);
  const files = parseUnifiedDiff(text);
  assert.equal(files.length, 2);
  assert.deepEqual(files.map((file) => file.category).sort(), ['source', 'test']);
  assert.deepEqual(collectDiffAtomicityFindings({ diffText: text }), []);
}

// Case 2: hand-written source mixed with a build artifact is fatal.
{
  const text = diff([
    'diff --git a/packages/core/dist/bundle.js b/packages/core/dist/bundle.js',
    '--- a/packages/core/dist/bundle.js',
    '+++ b/packages/core/dist/bundle.js',
    '@@ -1 +1,2 @@',
    " console.log('built');",
    "+console.log('rebuilt');",
    'diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts',
    '--- a/packages/core/src/index.ts',
    '+++ b/packages/core/src/index.ts',
    '@@ -1 +1,2 @@',
    ' export const x = 1;',
    '+export const y = 2;',
  ]);
  const findings = collectDiffAtomicityFindings({ diffText: text });
  assert.deepEqual(kinds(findings), ['mixed-generated-and-source']);
  assert.equal(findings[0].severity, 'fatal');
  assert.equal(findings[0].path, 'packages/core/dist/bundle.js');
}

// Case 3: a lockfile changed with no manifest change is fatal.
{
  const text = diff([
    'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
    '--- a/pnpm-lock.yaml',
    '+++ b/pnpm-lock.yaml',
    '@@ -1 +1,2 @@',
    ' lockfileVersion: 9.0',
    "+  '/left-pad@1.3.0': {}",
  ]);
  const findings = collectDiffAtomicityFindings({ diffText: text });
  assert.deepEqual(kinds(findings), ['orphaned-lockfile']);
  assert.equal(findings[0].severity, 'fatal');

  // A lockfile next to its manifest is allowed.
  const withManifest = diff([
    'diff --git a/package.json b/package.json',
    '--- a/package.json',
    '+++ b/package.json',
    '@@ -1 +1,2 @@',
    ' {',
    '+  "dependencies": { "left-pad": "1.3.0" }',
    'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
    '--- a/pnpm-lock.yaml',
    '+++ b/pnpm-lock.yaml',
    '@@ -1 +1,2 @@',
    ' lockfileVersion: 9.0',
    "+  '/left-pad@1.3.0': {}",
  ]);
  assert.deepEqual(collectDiffAtomicityFindings({ diffText: withManifest }), []);
}

// Case 4: a debugger statement added to source is fatal (AST detected, added-only).
{
  const text = diff([
    'diff --git a/packages/core/src/run.ts b/packages/core/src/run.ts',
    '--- a/packages/core/src/run.ts',
    '+++ b/packages/core/src/run.ts',
    '@@ -1,3 +1,4 @@',
    ' export function run() {',
    '+  debugger;',
    '   return 1;',
    ' }',
  ]);
  const findings = collectDiffAtomicityFindings({ diffText: text });
  assert.deepEqual(kinds(findings), ['debugger-statement']);
  assert.equal(findings[0].severity, 'fatal');
  assert.equal(findings[0].line, 2);
}

// A pre-existing debugger on a context line is not flagged.
{
  const text = diff([
    'diff --git a/packages/core/src/run.ts b/packages/core/src/run.ts',
    '--- a/packages/core/src/run.ts',
    '+++ b/packages/core/src/run.ts',
    '@@ -1,3 +1,4 @@',
    ' export function run() {',
    '   debugger;',
    '+  return 2;',
    ' }',
  ]);
  assert.deepEqual(collectDiffAtomicityFindings({ diffText: text }), []);
}

// Case 5: a focused test (.only) is fatal.
{
  const text = diff([
    'diff --git a/packages/core/src/run.test.ts b/packages/core/src/run.test.ts',
    '--- a/packages/core/src/run.test.ts',
    '+++ b/packages/core/src/run.test.ts',
    '@@ -1,2 +1,3 @@',
    " describe('run', () => {",
    "+  it.only('focused', () => {});",
    ' });',
  ]);
  const findings = collectDiffAtomicityFindings({ diffText: text });
  assert.deepEqual(kinds(findings), ['focused-test']);
  assert.equal(findings[0].severity, 'fatal');
}

// Case 6: a skipped test (.skip) is a warning, and unrelated areas warn too.
{
  const skipped = diff([
    'diff --git a/packages/core/src/run.test.ts b/packages/core/src/run.test.ts',
    '--- a/packages/core/src/run.test.ts',
    '+++ b/packages/core/src/run.test.ts',
    '@@ -1,2 +1,3 @@',
    " describe('run', () => {",
    "+  it.skip('later', () => {});",
    ' });',
  ]);
  const skippedFindings = collectDiffAtomicityFindings({ diffText: skipped });
  assert.deepEqual(kinds(skippedFindings), ['skipped-test']);
  assert.equal(skippedFindings[0].severity, 'warning');

  const spread = diff([
    'diff --git a/packages/core/src/a.ts b/packages/core/src/a.ts',
    '--- a/packages/core/src/a.ts',
    '+++ b/packages/core/src/a.ts',
    '@@ -1 +1,2 @@',
    ' export const a = 1;',
    '+export const a2 = 2;',
    'diff --git a/packages/app/src/b.ts b/packages/app/src/b.ts',
    '--- a/packages/app/src/b.ts',
    '+++ b/packages/app/src/b.ts',
    '@@ -1 +1,2 @@',
    ' export const b = 1;',
    '+export const b2 = 2;',
    'diff --git a/scripts/c.mjs b/scripts/c.mjs',
    '--- a/scripts/c.mjs',
    '+++ b/scripts/c.mjs',
    '@@ -1 +1,2 @@',
    ' export const c = 1;',
    '+export const c2 = 2;',
  ]);
  const spreadFindings = collectDiffAtomicityFindings({ diffText: spread });
  assert.deepEqual(kinds(spreadFindings), ['unrelated-areas']);
  assert.equal(spreadFindings[0].severity, 'warning');
  assert.match(formatDiffAtomicityFindings(spreadFindings)[0], /packages\/app/);
}

// Temp git case: the git entry path flags a real added debugger and exits 1,
// and a clean follow-up change passes with the success message on stdout.
{
  const root = mkdtempSync(path.join(tmpdir(), 'invoker-diff-atomicity-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root, stdio: 'ignore' });
    mkdirSync(path.join(root, 'packages/core/src'), { recursive: true });
    writeFileSync(path.join(root, 'packages/core/src/thing.ts'), 'export function run() {\n  return 1;\n}\n');
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: root, stdio: 'ignore' });

    writeFileSync(path.join(root, 'packages/core/src/thing.ts'), 'export function run() {\n  debugger;\n  return 1;\n}\n');
    execFileSync('git', ['commit', '-aqm', 'debug'], { cwd: root, stdio: 'ignore' });

    let failed = false;
    try {
      execFileSync(process.execPath, [scriptPath, '--root', root, '--base', 'HEAD~1'], { encoding: 'utf8' });
    } catch (error) {
      failed = true;
      assert.equal(error.status, 1);
      assert.match(String(error.stderr), /Diff atomicity validation failed:/);
      assert.match(String(error.stderr), /debugger-statement/);
    }
    assert.equal(failed, true, 'expected the linter to exit non-zero on an added debugger');

    writeFileSync(path.join(root, 'packages/core/src/thing.ts'), 'export function run() {\n  return 2;\n}\n');
    execFileSync('git', ['commit', '-aqm', 'clean'], { cwd: root, stdio: 'ignore' });
    const passOutput = execFileSync(process.execPath, [scriptPath, '--root', root, '--base', 'HEAD~1'], { encoding: 'utf8' });
    assert.match(passOutput, /Diff atomicity validation passed\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Temp git case: a full-context diff larger than Node's 1MB execFileSync
// default still lints. `--unified=200000` scales output with whole-file size,
// so a small edit to a large file can exceed the default and used to throw
// ENOBUFS before the diff was ever parsed.
{
  const root = mkdtempSync(path.join(tmpdir(), 'invoker-diff-atomicity-big-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root, stdio: 'ignore' });
    mkdirSync(path.join(root, 'packages/core/src'), { recursive: true });

    const filler = 'export const padding = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";\n';
    const fillerLines = Math.ceil((1024 * 1024 * 1.2) / filler.length);
    const bigFile = path.join(root, 'packages/core/src/big.ts');
    writeFileSync(bigFile, filler.repeat(fillerLines));
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: root, stdio: 'ignore' });

    writeFileSync(bigFile, `export const added = 1;\n${filler.repeat(fillerLines)}`);
    execFileSync('git', ['commit', '-aqm', 'small edit to a large file'], { cwd: root, stdio: 'ignore' });

    const findings = lintDiffAtomicityForGit({ root, baseRef: 'HEAD~1' });
    assert.ok(Array.isArray(findings), 'expected findings for an over-1MB full-context diff');

    const passOutput = execFileSync(process.execPath, [scriptPath, '--root', root, '--base', 'HEAD~1'], { encoding: 'utf8' });
    assert.match(passOutput, /Diff atomicity validation passed\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('ok pr diff atomicity');
