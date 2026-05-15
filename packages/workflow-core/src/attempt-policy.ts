import type { Attempt, AttemptStatus } from '@invoker/workflow-graph';

export const ACTIVE_ATTEMPT_STATUSES: readonly AttemptStatus[] = [
  'pending',
  'claimed',
  'running',
  'needs_input',
];

export const DISCARDED_ATTEMPT_STATUSES: readonly AttemptStatus[] = [
  'superseded',
];

export const OUTCOME_TERMINAL_ATTEMPT_STATUSES: readonly AttemptStatus[] = [
  'completed',
  'failed',
];

export function isActiveAttemptStatus(status: AttemptStatus | undefined): boolean {
  return status !== undefined && ACTIVE_ATTEMPT_STATUSES.includes(status);
}

export function isDiscardedAttemptStatus(status: AttemptStatus | undefined): boolean {
  return status !== undefined && DISCARDED_ATTEMPT_STATUSES.includes(status);
}

export function isOutcomeTerminalAttemptStatus(status: AttemptStatus | undefined): boolean {
  return status !== undefined && OUTCOME_TERMINAL_ATTEMPT_STATUSES.includes(status);
}

export function isTerminalAttemptStatus(status: AttemptStatus | undefined): boolean {
  return isDiscardedAttemptStatus(status) || isOutcomeTerminalAttemptStatus(status);
}

export function isActiveAttempt(attempt: Attempt | undefined): boolean {
  return isActiveAttemptStatus(attempt?.status);
}

export function isDiscardedAttempt(attempt: Attempt | undefined): boolean {
  return isDiscardedAttemptStatus(attempt?.status);
}

export function isOutcomeTerminalAttempt(attempt: Attempt | undefined): boolean {
  return isOutcomeTerminalAttemptStatus(attempt?.status);
}
