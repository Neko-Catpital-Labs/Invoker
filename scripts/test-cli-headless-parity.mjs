#!/usr/bin/env node

import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const GATE = join(scriptDir, 'check-cli-headless-parity.mjs');
const REGISTRY = join(repoRoot, 'packages/app/src/headless-command-registry.ts');
const DEBT = join(scriptDir, 'cli-headless-parity-debt.txt');

function runGate() {
  const result = spawnSync(process.execPath, [GATE], { cwd: repoRoot, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const backups = mkdtempSync(join(tmpdir(), 'cli-parity-test-'));
let restoreCounter = 0;

function withMutated(path, mutate) {
  const backup = join(backups, `backup-${(restoreCounter += 1)}`);
  copyFileSync(path, backup);
  try {
    writeFileSync(path, mutate(readFileSync(path, 'utf8')), 'utf8');
    return runGate();
  } finally {
    copyFileSync(backup, path);
  }
}

try {
  const clean = runGate();
  assert(clean.status === 0, `expected a clean repo to pass, got exit ${clean.status}\n${clean.stderr}`);
  assert(clean.stdout.includes('ok\tcli/headless parity'), `expected an ok line, got: ${clean.stdout}`);

  const unexposed = withMutated(REGISTRY, (source) =>
    source.replace("  { name: 'worker', kind: 'read' },", "  { name: 'worker', kind: 'read' },\n  { name: 'brand-new-verb', kind: 'write' },"),
  );
  assert(unexposed.status === 1, `expected exit 1 for an unexposed command, got ${unexposed.status}`);
  assert(unexposed.stderr.includes('brand-new-verb'), `expected the offending name, got: ${unexposed.stderr}`);

  const alreadyExposed = withMutated(DEBT, (source) => `${source}retry-task\n`);
  assert(alreadyExposed.status === 1, `expected exit 1 for a stale debt entry, got ${alreadyExposed.status}`);
  assert(alreadyExposed.stderr.includes('shrink-only'), `expected the shrink-only message, got: ${alreadyExposed.stderr}`);

  const notACommand = withMutated(DEBT, (source) => `${source}not-a-real-command\n`);
  assert(notACommand.status === 1, `expected exit 1 for an unknown debt entry, got ${notACommand.status}`);
  assert(notACommand.stderr.includes('stale entry'), `expected the stale-entry message, got: ${notACommand.stderr}`);

  const unparseable = withMutated(REGISTRY, (source) =>
    source.replace('export const HEADLESS_COMMANDS = [', 'export const HEADLESS_COMMANDS_RENAMED = ['),
  );
  assert(unparseable.status === 2, `expected exit 2 when the registry cannot be parsed, got ${unparseable.status}`);
  assert(unparseable.stderr.includes('this gate cannot run'), `expected a refusal, got: ${unparseable.stderr}`);

  const restored = runGate();
  assert(restored.status === 0, `expected the repo to be restored to green, got exit ${restored.status}`);

  process.stdout.write('ok\tcheck-cli-headless-parity: 6 assertions passed\n');
} finally {
  rmSync(backups, { recursive: true, force: true });
}
