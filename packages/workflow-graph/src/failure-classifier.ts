import type { FailureClass, SshInfraFailureClass } from './types.js';

/**
 * Single source of truth for categorizing task failures from their error text.
 *
 * Failure categorization used to be scattered: the requeue worker keyed off
 * `failureClass`, the infra-repair worker re-matched `execution.error`
 * substrings, and auto-fix gating had its own error-string checks. This class
 * centralizes the error-string → {@link FailureClass} mapping and the shared
 * predicates so producers (failure finalize) and consumers (workers, gating)
 * agree on one taxonomy.
 *
 * Note: review-gate CI infra is deliberately NOT handled here. It needs an
 * async CI-log fetch and the log is not in `execution.error`, so it stays in
 * `ci-failure-infra-classifier.ts`.
 */
export const SSH_INFRA_FAILURE_CLASSES: readonly SshInfraFailureClass[] = [
  'ssh-env-invalid-export',
  'ssh-worktree-missing',
  'ssh-invalid-reference',
  'ssh-repo-mirror-corrupt',
  'ssh-oauth-session-expired',
];

export class FailureClassifier {
  /**
   * Map a failed task's `execution.error` to a persisted infra failure class,
   * or `undefined` when the text does not match a known machine-owned bucket.
   * Matches are narrow and exact by design — an unknown failure is a code
   * failure, not an infra failure.
   */
  static classifyError(errorText: string | undefined): SshInfraFailureClass | undefined {
    if (typeof errorText !== 'string') return undefined;
    if (errorText.includes('.invoker/env.sh') && errorText.includes('not a valid identifier')) {
      return 'ssh-env-invalid-export';
    }
    if (errorText.includes('.invoker/worktrees/') && errorText.includes('No such file or directory')) {
      return 'ssh-worktree-missing';
    }
    if (
      errorText.includes('fatal: invalid reference:')
      || errorText.includes('Cannot apply a fix because this task has no saved workspace.')
    ) {
      return 'ssh-invalid-reference';
    }
    if (
      errorText.includes('phase=bootstrap_clone_fetch')
      && errorText.includes('fatal: not a git repository (or any of the parent directories): .git')
    ) {
      return 'ssh-repo-mirror-corrupt';
    }
    if (errorText.includes('Failed to authenticate: OAuth session expired and could not be refreshed')) {
      return 'ssh-oauth-session-expired';
    }
    return undefined;
  }

  /** True when the failure was a liveness stall (owned by the requeue worker). */
  static isLiveness(failureClass: FailureClass | undefined): boolean {
    return failureClass === 'liveness_stall';
  }

  /** True when the failure is a machine-owned SSH infra bucket (owned by infra-repair). */
  static isSshInfra(failureClass: FailureClass | undefined): failureClass is SshInfraFailureClass {
    return failureClass !== undefined
      && (SSH_INFRA_FAILURE_CLASSES as readonly string[]).includes(failureClass);
  }

  /**
   * True when the error text is an operator-initiated cancellation/termination
   * rather than a genuine failure, so auto-fix should not engage.
   */
  static isCancellation(errorText: unknown): boolean {
    if (typeof errorText !== 'string') return false;
    return errorText.startsWith('Cancelled by user') || errorText.startsWith('Cancelled:')
      || errorText.startsWith('Terminated by user') || errorText.startsWith('Terminated:');
  }
}
