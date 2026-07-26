#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const defaultDocPath = 'docs/persistence-architecture-single-writer.md';
const docPath = process.argv[2] ?? findDefaultDoc(process.cwd());

function findDefaultDoc(startDir) {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, defaultDocPath);
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      return defaultDocPath;
    }
    dir = parent;
  }
}

function fail(message) {
  console.error(`verify-empty-canonical-sweeps: ${message}`);
  process.exit(1);
}

if (!existsSync(docPath)) {
  fail(`missing target doc: ${docPath}`);
}

const text = readFileSync(docPath, 'utf8');
const lines = text.split(/\r?\n/);

function matchingLines(predicate) {
  return lines
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => predicate(line));
}

function printMatches(matches) {
  for (const match of matches) {
    console.error(`${match.number}:${match.line}`);
  }
}

function assertMissing(token, message) {
  const matches = matchingLines((line) => line.includes(token));
  if (matches.length > 0) {
    printMatches(matches);
    fail(message);
  }
}

function assertPresent(token, message) {
  if (!text.includes(token)) {
    fail(message);
  }
}

const staleTokens = [
  'invoker:restart-task',
  'rebase-and-retry',
  'recreate-with-rebase',
  '/restart',
  'restartTask(',
  'rebaseAndRetry(',
  'set executor',
  'GitHub PR',
  'pull_request',
];

for (const token of staleTokens) {
  assertMissing(token, `stale canonical reference remains: ${token}`);
}

const staleMergeLabels = [
  'manual | github',
  'github | manual',
  'manual | automatic | github',
  'github, manual',
  'mergeMode: github',
  'mergeMode=github',
  'merge-mode: github',
  'merge-mode=github',
  '`github`',
];

for (const token of staleMergeLabels) {
  assertMissing(token, `stale merge-mode label remains: ${token}`);
}

assertPresent('| `invoker:retry-task` |', 'missing canonical GUI retry task surface');
assertPresent('| `retry-task` |', 'missing canonical headless retry task surface');
assertPresent('| `invoker:rebase-retry` |', 'missing canonical GUI rebase retry surface');
assertPresent('| `invoker:rebase-recreate` |', 'missing canonical GUI rebase recreate surface');
assertPresent('| `rebase-retry` |', 'missing canonical headless rebase retry surface');
assertPresent('| `rebase-recreate` |', 'missing canonical headless rebase recreate surface');
assertPresent('| `set pool` |', 'missing canonical headless pool configuration surface');
assertPresent('Values: `manual`, `automatic`, `external_review`', 'missing canonical merge-mode values');
assertPresent("merge_mode = 'github'", 'missing allowed SQLite merge_mode compatibility context');

const unexpectedGithub = matchingLines((line) => {
  return line.toLowerCase().includes('github') && !line.includes("merge_mode = 'github'");
});

if (unexpectedGithub.length > 0) {
  printMatches(unexpectedGithub);
  fail('unexpected github reference outside the allowed SQLite migration context');
}

console.log(`PASS: canonical docs sweep is empty for ${docPath}`);
