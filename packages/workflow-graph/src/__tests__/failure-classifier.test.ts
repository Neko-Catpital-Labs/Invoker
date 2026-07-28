import { describe, it, expect } from 'vitest';
import { FailureClassifier, SSH_INFRA_FAILURE_CLASSES } from '../failure-classifier.js';

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

  it('returns undefined for ordinary code failures and non-strings', () => {
    expect(FailureClassifier.classifyError('AssertionError: expected 1 to be 2')).toBeUndefined();
    expect(FailureClassifier.classifyError(undefined)).toBeUndefined();
    expect(FailureClassifier.classifyError(42 as unknown as string)).toBeUndefined();
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
});
