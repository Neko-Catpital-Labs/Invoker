import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, disposition } from '../scripts/failure-digest.mjs';

test('provision-stage death (no payload marker) is ssh-provision-death', () => {
  const err = [
    '[SshExecutor] Installing managed worktree dependencies...',
    "bash: scripts/provision-ssh-worker.sh: No such file or directory",
  ].join('\n');
  assert.equal(classifyError(err), 'ssh-provision-death');
});

test('payload-stage module error is NOT ssh-provision-death', () => {
  const err = [
    '[SshExecutor] Installing managed worktree dependencies...',
    '[SshExecutor] Running task payload...',
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@x/y'",
  ].join('\n');
  assert.equal(classifyError(err), 'missing-node-deps');
});

test('multi-claim merge gate is its own class', () => {
  const err = 'Merge failed: workflow wf-x carries 3 review claims, but it would publish as one PR';
  assert.equal(classifyError(err), 'merge-gate-multi-claim');
});

test('deterministic payload failure is code-or-precondition', () => {
  assert.equal(
    classifyError('ValueError: Case is not in the unpromoted mining queue: foo'),
    'code-or-precondition',
  );
});

test('usage limit detected', () => {
  assert.equal(classifyError('Claude usage limit reached'), 'usage-limit');
});

test('invalid reference is ssh-infra', () => {
  assert.equal(classifyError('fatal: invalid reference: origin/master'), 'ssh-infra');
});

test('multi-claim disposition never recommends retry', () => {
  assert.match(disposition('merge-gate-multi-claim'), /replan/);
});

test('budget-exhausted disposition', () => {
  const d = disposition('code-or-precondition', {
    lastEvent: 'worker-autofix-skip',
    reason: 'worker-retry-budget-exhausted',
  });
  assert.match(d, /budget exhausted/);
});

test('not-eligible disposition names the exclusion', () => {
  const d = disposition('code-or-precondition', {
    lastEvent: 'worker-autofix-skip',
    reason: 'not-eligible',
  });
  assert.match(d, /ineligible/);
});
