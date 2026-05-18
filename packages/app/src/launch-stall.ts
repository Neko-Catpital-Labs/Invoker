import type { Attempt, TaskStatus } from '@invoker/workflow-core';

export interface LaunchStallEvaluationInput {
  now: Date;
  status: TaskStatus;
  phase?: 'launching' | 'executing';
  launchStartedAt?: Date;
  selectedAttempt?: Pick<Attempt, 'status' | 'claimedAt' | 'lastHeartbeatAt' | 'leaseExpiresAt'>;
  hasExecutionHandle: boolean;
  isKnownLaunching: boolean;
  launchingStallTimeoutMs: number;
}

export interface LaunchStallEvaluation {
  launchAgeMs: number;
  launchClaimedForCurrentAttempt: boolean;
  launchLeaseActive: boolean;
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
  const launchLeaseActive = selectedAttempt?.leaseExpiresAt !== undefined
    && selectedAttempt.leaseExpiresAt.getTime() > now.getTime();
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
    && !launchLeaseActive
    && !hasExecutionHandle
    && !isKnownLaunching;

  return {
    launchAgeMs,
    launchClaimedForCurrentAttempt,
    launchLeaseActive,
    launchStalled,
  };
}
