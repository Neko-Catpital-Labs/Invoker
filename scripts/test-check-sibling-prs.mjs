#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHECK_SIBLING_PRS = join(ROOT, 'scripts', 'check-sibling-prs.mjs');

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf-8', ...options }).trim();
}

function git(cwd, ...args) {
  return run('git', ['-C', cwd, ...args]);
}

function gitQuiet(cwd, ...args) {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

function writeExecutable(path, content) {
  writeFileSync(path, content, { mode: 0o755 });
}

function commitFile(work, relPath, content, message) {
  const fullPath = join(work, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  git(work, 'add', relPath);
  gitQuiet(work, 'commit', '-m', message);
}

function createHarness() {
  const root = mkdtempSync(join(tmpdir(), 'check-sibling-prs-'));
  const binDir = join(root, 'bin');
  const work = join(root, 'work');
  mkdirSync(binDir);

  writeExecutable(join(binDir, 'gh'), `#!/bin/sh
if [ -n "$GH_FAIL_MESSAGE" ]; then
  printf '%s\\n' "$GH_FAIL_MESSAGE" >&2
  exit 2
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '%s' "$GH_PR_LIST_JSON"
  exit 0
fi
printf 'unexpected gh invocation: %s\\n' "$*" >&2
exit 3
`);

  gitQuiet(root, 'init', '-q', '-b', 'master', work);
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'test-user');
  commitFile(work, 'README.md', 'seed\n', 'seed');
  gitQuiet(work, 'checkout', '-q', '-b', 'feature/current');
  commitFile(work, 'src/shared.ts', 'export const shared = 1;\n', 'touch shared');
  commitFile(work, 'src/current-only.ts', 'export const currentOnly = 1;\n', 'touch current-only');

  return {
    root,
    work,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
    },
  };
}

function runCheck(work, harness, envOverrides = {}) {
  return spawnSync(process.execPath, [CHECK_SIBLING_PRS, '--base', 'master'], {
    cwd: work,
    env: { ...harness.env, ...envOverrides },
    encoding: 'utf-8',
  });
}

function testOverlapAndNoOverlapReporting() {
  const harness = createHarness();
  try {
    const result = runCheck(harness.work, harness, {
      GH_PR_LIST_JSON: JSON.stringify([
        {
          number: 101,
          title: 'current branch PR',
          headRefName: 'feature/current',
          files: [{ path: 'src/shared.ts' }],
        },
        {
          number: 102,
          title: 'touches same outage file',
          headRefName: 'feature/sibling',
          files: [{ path: 'src/shared.ts' }, { path: 'src/other.ts' }],
        },
        {
          number: 103,
          title: 'unrelated work',
          headRefName: 'feature/unrelated',
          files: [{ path: 'docs/unrelated.md' }],
        },
      ]),
    });

    assert.equal(result.status, 0, `overlap case should exit 0\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /#102 touches same outage file -- overlaps: src\/shared\.ts/);
    assert.doesNotMatch(result.stdout, /#101 current branch PR/);
    assert.doesNotMatch(result.stdout, /#103 unrelated work/);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}

function testGhFailurePrintsCouldNotRunAndExitsZero() {
  const harness = createHarness();
  try {
    const result = runCheck(harness.work, harness, { GH_FAIL_MESSAGE: 'gh auth missing' });

    assert.equal(result.status, 0, `gh failure should still exit 0\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /sibling-pr check could not run: gh auth missing/);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
}

testOverlapAndNoOverlapReporting();
testGhFailurePrintsCouldNotRunAndExitsZero();
console.log('ok      test-check-sibling-prs.mjs (3 cases)');
