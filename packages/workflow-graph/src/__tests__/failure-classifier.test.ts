import { describe, it, expect } from 'vitest';
import { PR_6976_OAUTH_SESSION_EXPIRED_ERROR } from '../../../execution-engine/src/__tests__/fixtures/pr-6976-oauth-session-expired.js';
import { FailureClassifier, SSH_INFRA_FAILURE_CLASSES } from '../failure-classifier.js';

const GIT_REF_PATH_CONFLICT_ERROR =
  "fatal: cannot lock ref 'refs/heads/experiment/child': "
  + 'unable to create directory for .git/refs/heads/experiment/child';

describe('FailureClassifier.classifyError', () => {
  it('classifies the env.sh invalid-export signature', () => {
    expect(FailureClassifier.classifyError(
      'export BADVAR: not a valid identifier while sourcing /home/ci/.invoker/env.sh',
    )).toBe('ssh-env-invalid-export');
  });

  it('classifies the missing-worktree signature', () => {
    expect(FailureClassifier.classifyError(
      'cd ~/.invoker/worktrees/repo/task-1: No such file or directory',
    )).toBe('ssh-worktree-missing');
  });

  it('classifies the invalid-reference signatures', () => {
    expect(FailureClassifier.classifyError('fatal: invalid reference: refs/heads/x')).toBe('ssh-invalid-reference');
    expect(FailureClassifier.classifyError('Cannot apply a fix because this task has no saved workspace.'))
      .toBe('ssh-invalid-reference');
  });

  it('classifies the corrupt-repo-mirror signature', () => {
    expect(FailureClassifier.classifyError(
      'SSH remote script failed (exit=128, phase=bootstrap_clone_fetch)\n'
      + 'STDERR:\n'
      + 'fatal: not a git repository (or any of the parent directories): .git\n'
      + '[WARNING] Git fetch failed for /home/invoker/.invoker/repos/647faa73e90e\n'
      + '[WARNING] Continuing with existing refs. Tasks may use stale commits.\n'
      + "ERROR: base ref 'master' not found and fallback 'origin/master' also missing\n",
    )).toBe('ssh-repo-mirror-corrupt');
  });

  it('classifies finalize-time stale managed-worktree admin metadata', () => {
    expect(FailureClassifier.classifyError(
      'remote commit or push failed (code 128): fatal: not a git repository: '
      + '/home/invoker/.invoker/repos/c9d4f5f68faf/.git/worktrees/'
      + 'experiment-wf-1787334654569-9-repair-g0.t0.a-a0a740992-ff047c23',
    )).toBe('ssh-worktree-corrupt');
  });

  it('classifies finalize-time worktree corruption when git omits the admin path', () => {
    expect(FailureClassifier.classifyError(
      'remote commit or push failed (code 128): fatal: not a git repository: (null)',
    )).toBe('ssh-worktree-corrupt');
  });

  it('does not classify a bare "not a git repository" outside the finalize commit/push path', () => {
    expect(FailureClassifier.classifyError(
      'fatal: not a git repository: (null)',
    )).toBeUndefined();
  });

  it('classifies the OAuth-session-expired signature', () => {
    expect(FailureClassifier.classifyError(PR_6976_OAUTH_SESSION_EXPIRED_ERROR))
      .toBe('ssh-oauth-session-expired');
  });

  it('classifies an explicit disk-full signature', () => {
    expect(FailureClassifier.classifyError(
      'No space left on device',
    )).toBe('ssh-disk-full');
  });

  it('does not classify a non-ENOSPC Git ref-path conflict as disk-full', () => {
    expect(FailureClassifier.classifyError(GIT_REF_PATH_CONFLICT_ERROR)).toBeUndefined();
  });

  it('does not classify a bare "not a git repository" outside the bootstrap-clone phase', () => {
    expect(FailureClassifier.classifyError(
      'fatal: not a git repository (or any of the parent directories): .git',
    )).toBeUndefined();
  });

  it('classifies transport failures after definitive infrastructure checks miss', () => {
    expect(FailureClassifier.classifyError('SSH transport failed (exit 255): connection reset by peer.'))
      .toBe('ssh-transport-transient');
    expect(FailureClassifier.classifyError('SSH remote script failed (exit=1, phase=run_task)'))
      .toBeUndefined();
  });

  it('returns undefined for ordinary code failures and non-strings', () => {
    expect(FailureClassifier.classifyError('AssertionError: expected 1 to be 2')).toBeUndefined();
    expect(FailureClassifier.classifyError(undefined)).toBeUndefined();
    expect(FailureClassifier.classifyError(42 as unknown as string)).toBeUndefined();
  });
});

describe('FailureClassifier.classifyAgentQuotaRefusal', () => {
  it('classifies both real agent-quota failure shapes seen in production', () => {
    expect(FailureClassifier.classifyAgentQuotaRefusal(
      '[Fix with Agent failed] SSH remote script failed (exit=1, phase=remote_agent_fix)\n'
      + "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to "
      + 'purchase more credits or try again at Aug 20th, 2026 4:36 AM.',
    )).toBe('agent-usage-limit');
    expect(FailureClassifier.classifyAgentQuotaRefusal(
      'codex fix exited with code 1: [assistant] Model refused: usage limit reached',
    )).toBe('agent-usage-limit');
  });

  it('ignores a third-party CI check row that reports its own rate limiting', () => {
    const mergeGateCheckTable = [
      'quality / TypeScript Types\tpass\t42s\thttps://github.com/o/r/actions/runs/33484479428/job/99781265672\t',
      'CodeRabbit\tpass\t0\t\tReview rate limited',
      'UI Vitest\tpass\t2m44s\thttps://github.com/o/r/actions/runs/33484479428/job/99781265910\t',
      '[worktree] Process exited: actionId=wf-1788249568173-6/land-verified-pr exitCode=1',
    ].join('\n');
    expect(FailureClassifier.classifyAgentQuotaRefusal(mergeGateCheckTable)).toBeUndefined();
  });

  it('classifies a provider HTTP rate-limit refusal', () => {
    expect(FailureClassifier.classifyAgentQuotaRefusal(
      'API error: 429 {"type":"error","error":{"type":"rate_limit_error",'
      + '"message":"Number of request tokens has exceeded your per-minute rate limit"}}',
    )).toBe('agent-usage-limit');
  });
});

describe('FailureClassifier predicates', () => {
  it('isLiveness only matches liveness_stall', () => {
    expect(FailureClassifier.isLiveness('liveness_stall')).toBe(true);
    expect(FailureClassifier.isLiveness('ssh-env-invalid-export')).toBe(false);
    expect(FailureClassifier.isLiveness(undefined)).toBe(false);
  });

  it('isSshInfra matches every ssh infra bucket and nothing else', () => {
    for (const cls of SSH_INFRA_FAILURE_CLASSES) {
      expect(FailureClassifier.isSshInfra(cls)).toBe(true);
    }
    expect(FailureClassifier.isSshInfra('liveness_stall')).toBe(false);
    expect(FailureClassifier.isSshInfra(undefined)).toBe(false);
  });

  it('isCancellation matches operator cancellations only', () => {
    expect(FailureClassifier.isCancellation('Cancelled by user')).toBe(true);
    expect(FailureClassifier.isCancellation('Terminated: shutdown')).toBe(true);
    expect(FailureClassifier.isCancellation('boom')).toBe(false);
    expect(FailureClassifier.isCancellation(undefined)).toBe(false);
  });

  it('isUsageLimit matches both real agent-quota failure shapes seen in production', () => {
    // Live incident text captured from a real failed task's execution.error.
    expect(FailureClassifier.isUsageLimit(
      '[Fix with Agent failed] SSH remote script failed (exit=1, phase=remote_agent_fix)\n'
      + "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to "
      + 'purchase more credits or try again at Aug 20th, 2026 4:36 AM.',
    )).toBe(true);
    // Distinct phrasing this repo's own codex-driver tests already model.
    expect(FailureClassifier.isUsageLimit(
      'codex fix exited with code 1: [assistant] Model refused: usage limit reached',
    )).toBe(true);
    expect(FailureClassifier.isUsageLimit('AssertionError: expected 1 to be 2')).toBe(false);
    expect(FailureClassifier.isUsageLimit(undefined)).toBe(false);
  });

  it('isUsageLimit ignores a third-party CI check row that reports its own rate limiting', () => {
    // Live incident 2026-09-12: attempt wf-1788249568173-6/land-verified-pr-acbb90da0
    // failed on CI, and its execution.error is the merge gate's check table. One row
    // is CodeRabbit reporting its own review throttling on a PASSING check. That row
    // tripped the fleet-wide auto-fix breaker for 6h even though no agent quota was hit.
    const mergeGateCheckTable = [
      'quality / TypeScript Types\tpass\t42s\thttps://github.com/o/r/actions/runs/33484479428/job/99781265672\t',
      'CodeRabbit\tpass\t0\t\tReview rate limited',
      'UI Vitest\tpass\t2m44s\thttps://github.com/o/r/actions/runs/33484479428/job/99781265910\t',
      '[worktree] Process exited: actionId=wf-1788249568173-6/land-verified-pr exitCode=1',
    ].join('\n');
    expect(FailureClassifier.isUsageLimit(mergeGateCheckTable)).toBe(false);
  });

  it('isUsageLimit still matches a provider HTTP rate-limit refusal', () => {
    expect(FailureClassifier.isUsageLimit(
      'API error: 429 {"type":"error","error":{"type":"rate_limit_error",'
      + '"message":"Number of request tokens has exceeded your per-minute rate limit"}}',
    )).toBe(true);
  });
});
