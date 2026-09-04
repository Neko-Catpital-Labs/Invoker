#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveAtomicityBaseRef,
  changedFilesSinceBase,
  fullContextDiffSinceBase,
} from './create-pr.mjs';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function writeAndCommit(cwd, relPath, contents, message) {
  const full = path.join(cwd, relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
  git(cwd, ['add', relPath]);
  git(cwd, ['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '-m', message]);
}

function buildStackedRepoFixture(root) {
  const bareDir = path.join(root, 'origin.git');
  const workDir = path.join(root, 'work');

  mkdirSync(bareDir, { recursive: true });
  git(bareDir, ['init', '--bare', '-q']);

  mkdirSync(workDir, { recursive: true });
  git(workDir, ['init', '-q', '-b', 'master']);
  git(workDir, ['remote', 'add', 'origin', bareDir]);
  writeAndCommit(workDir, 'packages/a/index.ts', 'export const a = 1;\n', 'init');
  git(workDir, ['push', '-u', 'origin', 'master']);

  git(workDir, ['checkout', '-q', '-b', 'stack/pr-adds-b']);
  writeAndCommit(workDir, 'packages/b/index.ts', 'export const b = 1;\n', 'pr-adds-b: add b');
  git(workDir, ['push', '-u', 'origin', 'stack/pr-adds-b']);

  git(workDir, ['checkout', '-q', '-b', 'stack/pr-adds-c']);
  writeAndCommit(workDir, 'packages/c/index.ts', 'export const c = 1;\n', 'pr-adds-c: add c');
  git(workDir, ['push', '-u', 'origin', 'stack/pr-adds-c']);

  return workDir;
}

function assertStandaloneBaseUnchanged() {
  const baseRef = resolveAtomicityBaseRef('master', { managed: false }, '');
  assert.equal(baseRef, 'origin/master');
}

function assertManagedWithNoResolvedParentFallsBackToDeclaredBase() {
  const baseRef = resolveAtomicityBaseRef('master', { managed: true }, '');
  assert.equal(baseRef, 'origin/master');
}

function assertStackedBaseResolvesToRealParentBranch() {
  const baseRef = resolveAtomicityBaseRef('master', { managed: true }, 'stack/pr-adds-b');
  assert.equal(baseRef, 'origin/stack/pr-adds-b');
}

function assertIncrementalDiffExcludesParentStackChanges(workDir) {
  process.chdir(workDir);
  git(workDir, ['checkout', '-q', 'stack/pr-adds-c']);

  const cumulativeFromMaster = changedFilesSinceBase('origin/master');
  assert.deepEqual(cumulativeFromMaster.sort(), ['packages/b/index.ts', 'packages/c/index.ts']);

  const incrementalBaseRef = resolveAtomicityBaseRef('master', { managed: true }, 'stack/pr-adds-b');
  const incrementalFromStackParent = changedFilesSinceBase(incrementalBaseRef);
  assert.deepEqual(incrementalFromStackParent, ['packages/c/index.ts']);

  const incrementalDiff = fullContextDiffSinceBase(incrementalBaseRef);
  assert.match(incrementalDiff, /packages\/c\/index\.ts/);
  assert.doesNotMatch(incrementalDiff, /packages\/b\/index\.ts/);
}

const root = mkdtempSync(path.join(tmpdir(), 'atomicity-base-ref-'));
const startingCwd = process.cwd();

try {
  const workDir = buildStackedRepoFixture(root);
  assertStandaloneBaseUnchanged();
  assertManagedWithNoResolvedParentFallsBackToDeclaredBase();
  assertStackedBaseResolvesToRealParentBranch();
  assertIncrementalDiffExcludesParentStackChanges(workDir);
  console.log('ok      test-create-pr-atomicity-base-ref.mjs (4 cases)');
} finally {
  process.chdir(startingCwd);
  rmSync(root, { recursive: true, force: true });
}
