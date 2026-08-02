#!/usr/bin/env node
/**
 * REPRO Issue 5 — The generic label OVERWRITES real errors.
 *
 * A genuine SSH executor-startup failure keeps its true error string, but a
 * task orphaned by the owner crash is flattened to "Application quit" — same
 * infra family, opposite fidelity. This is the observable mislabel.
 *
 * Fixtures are real records captured via `run.sh --headless query tasks`:
 *   fixtures/task-real-ssh-error-wf-1785622791407-25.json  (error preserved)
 *   fixtures/task-orphaned-wf-1785627898757-34.json        (error flattened)
 *
 * Set INVOKER_LIVE=1 to additionally re-query the live store and confirm the
 * fixtures still match.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assert, done } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

function failedExec(file) {
  const tasks = JSON.parse(readFileSync(path.join(here, 'fixtures', file), 'utf8'));
  const t = tasks.find(x => x.status === 'failed');
  return { id: t.id, ...t.execution };
}

const real = failedExec('task-real-ssh-error-wf-1785622791407-25.json');
const orphan = failedExec('task-orphaned-wf-1785627898757-34.json');

assert(
  'genuine SSH startup failure PRESERVES its real error',
  /SSH remote script failed \(exit=255, phase=list_worktrees\)/.test(real.error),
  [`${real.id}: ${real.error.split('\n')[0]}`],
);

assert(
  'orphaned SSH task is FLATTENED to the generic "Application quit"',
  orphan.error === 'Application quit' && orphan.phase === 'launching',
  [`${orphan.id}: error="${orphan.error}" phase=${orphan.phase} exitCode=${orphan.exitCode}`],
);

assert(
  'both are the same infra family, but only one keeps a diagnosable cause',
  real.error.includes('ssh') && orphan.error === 'Application quit',
  ['→ operators triaging the orphaned task see "Application quit" with no SSH/OAuth signal'],
);

if (process.env.INVOKER_LIVE === '1') {
  const liveErr = (wf) => {
    const out = execFileSync('./run.sh', ['--headless', 'query', 'tasks', '--workflow', wf, '--output', 'json'],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const t = JSON.parse(out).find(x => x.status === 'failed');
    return t?.execution?.error;
  };
  assert('live store still shows "Application quit" on the orphaned task',
    liveErr('wf-1785627898757-34') === 'Application quit');
}

done('the generic reason overwrites real SSH failure context (label loses the cause)');
