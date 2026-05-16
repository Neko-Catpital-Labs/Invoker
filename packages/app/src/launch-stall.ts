import type { Attempt, TaskStatus } from '@invoker/workflow-core';

export interface LaunchStallEvaluationInput {
  now: Date;
  status: TaskStatus;
  phase?: 'launching' | 'executing';
  launchStartedAt?: Date;
  selectedAttempt?: Pick<Attempt, 'status' | 'claimedAt'>;
  hasExecutionHandle: boolean;
  isKnownLaunching: boolean;
  launchingStallTimeoutMs: number;
}

export interface LaunchStallEvaluation {
  launchAgeMs: number;
  launchClaimedForCurrentAttempt: boolean;
  launchStalled: boolean;
}

export function evaluateLaunchStall(input: LaunchStallEvaluationInput): LaunchStallEvaluation {
  const {
    now,
    status,
    phase,
    launchStartedAt,
    selectedAttempt,
    hasExecutionHandle,
    isKnownLaunching,
    launchingStallTimeoutMs,
  } = input;
  const launchAgeMs = launchStartedAt ? now.getTime() - launchStartedAt.getTime() : 0;
  const launchClaimedForCurrentAttempt = status === 'running'
    || (
      status === 'pending'
      && (selectedAttempt?.status === 'claimed' || selectedAttempt?.status === 'running')
      && selectedAttempt.claimedAt !== undefined
    );
  const launchStalled =
    phase === 'launching'
    && launchStartedAt !== undefined
    && launchAgeMs >= launchingStallTimeoutMs
    && launchClaimedForCurrentAttempt
    && !hasExecutionHandle
    && !isKnownLaunching;

  return {
    launchAgeMs,
    launchClaimedForCurrentAttempt,
    launchStalled,
  };
}
