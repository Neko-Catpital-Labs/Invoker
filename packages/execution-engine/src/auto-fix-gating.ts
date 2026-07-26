import {
  isLivenessFailureClass,
  parseMergeConflictError,
  type TaskState,
} from '@invoker/workflow-core';

export type AutoFixFailureBucket =
  | 'user_cancelled'
  | 'infra_setup'
  | 'infra_auth'
  | 'infra_transport'
  | 'infra_cleanup'
  | 'git_auth'
  | 'liveness_stall'
  | 'merge_conflict'
  | 'code_or_unknown';

const AUTO_FIX_SKIPPED_BUCKETS = new Set<AutoFixFailureBucket>([
  'user_cancelled',
  'infra_setup',
  'infra_auth',
  'infra_transport',
  'infra_cleanup',
  'git_auth',
  'liveness_stall',
]);

const USER_CANCELLED_PREFIXES = [
  'Cancelled by user',
  'Cancelled:',
  'Terminated by user',
  'Terminated:',
] as const;

const INFRA_SETUP_SNIPPETS = [
  'err_pnpm_outdated_lockfile',
  'err_pnpm_unsupported_engine',
  'executor startup failed',
  'worktree provisioning failed',
  'no valid workspace for failed task',
] as const;

const INFRA_AUTH_SNIPPETS = [
  'refresh token was already used',
  '401 unauthorized',
] as const;

const INFRA_TRANSPORT_SNIPPETS = [
  'ssh transport failed',
  'broken pipe',
  'remote session terminated unexpectedly',
  'application quit',
] as const;

const INFRA_CLEANUP_SNIPPETS = [
  'pop_var_context',
  'orphan function call output',
  '[sshexecutor] recording task result and pushing branch on remote...',
] as const;

function includesAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function classifyAutoFixFailureText(
  errorText: unknown,
  failureClass?: TaskState['execution']['failureClass'],
): AutoFixFailureBucket {
  if (isLivenessFailureClass(failureClass)) {
    return 'liveness_stall';
  }
  if (typeof errorText !== 'string') {
    return 'code_or_unknown';
  }
  const text = errorText.trim();
  if (!text) {
    return 'code_or_unknown';
  }
  if (USER_CANCELLED_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    return 'user_cancelled';
  }
  if (parseMergeConflictError(text) || text.includes('Merge failed: CONFLICT')) {
    return 'merge_conflict';
  }

  const lower = text.toLowerCase();
  if (includesAny(lower, INFRA_AUTH_SNIPPETS)) {
    return 'infra_auth';
  }
  if (lower.includes('remote commit or push failed (code 128): remote: invalid username or token')) {
    return 'git_auth';
  }
  if (
    text.startsWith('Executor cleanup failed (ssh remote finalize):')
    || includesAny(lower, INFRA_CLEANUP_SNIPPETS)
  ) {
    return 'infra_cleanup';
  }
  if (includesAny(lower, INFRA_TRANSPORT_SNIPPETS)) {
    return 'infra_transport';
  }
  if (
    text === '[SshExecutor] Running task payload...'
    || includesAny(lower, INFRA_SETUP_SNIPPETS)
  ) {
    return 'infra_setup';
  }
  return 'code_or_unknown';
}

export function normalizeAutoFixRetryBudget(raw: unknown): number {
  if (raw === Number.POSITIVE_INFINITY) {
    return Number.POSITIVE_INFINITY;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return 0;
  }
  const budget = Math.floor(raw);
  return budget > 0 ? budget : 0;
}

export function classifyAutoFixFailure(task: Pick<TaskState, 'execution'>): AutoFixFailureBucket {
  return classifyAutoFixFailureText(task.execution.error, task.execution.failureClass);
}

export function shouldSkipAutoFixForTask(task: Pick<TaskState, 'execution'>): boolean {
  return AUTO_FIX_SKIPPED_BUCKETS.has(classifyAutoFixFailure(task));
}

export function shouldSkipAutoFixForError(errorText: unknown): boolean {
  return AUTO_FIX_SKIPPED_BUCKETS.has(classifyAutoFixFailureText(errorText));
}

export function isLivenessFailureTask(task: Pick<TaskState, 'execution'>): boolean {
  return classifyAutoFixFailure(task) === 'liveness_stall';
}
