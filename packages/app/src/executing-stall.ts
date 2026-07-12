import type { RunnerKind, TaskState } from '@invoker/workflow-core';

export interface ExecutingStallEvaluationInput {
  now: Date;
  phase?: 'launching' | 'executing';
  runnerKind?: RunnerKind;
  executingStartedAt?: Date;
  leaseExpiresAt?: Date;
  executorHeartbeatAt?: Date;
  remoteHeartbeatAt?: Date;
  executingStallTimeoutMs: number;
}

export interface ExecutingStallEvaluation {
  heartbeatStale: boolean;
  leaseExpired: boolean;
  executingStalled: boolean;
  staleReason: string;
}

export function evaluateExecutingStall(input: ExecutingStallEvaluationInput): ExecutingStallEvaluation {
  const {
    now,
    phase,
    runnerKind,
    executingStartedAt,
    leaseExpiresAt,
    executorHeartbeatAt,
    remoteHeartbeatAt,
    executingStallTimeoutMs,
  } = input;
  const heartbeatSource = runnerKind === 'ssh'
    ? (remoteHeartbeatAt ?? executorHeartbeatAt)
    : executorHeartbeatAt;
  const heartbeatStale =
    !heartbeatSource || now.getTime() - heartbeatSource.getTime() >= executingStallTimeoutMs;
  const leaseExpired = !!leaseExpiresAt && leaseExpiresAt.getTime() < now.getTime();
  const leaseStillValid = !!leaseExpiresAt && leaseExpiresAt.getTime() >= now.getTime();
  const executingAgeMs = executingStartedAt ? now.getTime() - executingStartedAt.getTime() : 0;
  const executingStalled =
    phase === 'executing'
    && executingStartedAt !== undefined
    && executingAgeMs >= executingStallTimeoutMs
    && (leaseExpired || (!leaseStillValid && heartbeatStale));

  const staleReason = leaseExpired
    ? 'attempt lease expired'
    : runnerKind === 'ssh'
    ? 'remote workload heartbeat stale'
    : 'executor heartbeat stale';

  return {
    heartbeatStale,
    leaseExpired,
    executingStalled,
    staleReason,
  };
}

export function taskNeedsExecutingStallCheck(
  task: Pick<TaskState, 'status' | 'execution'>,
): boolean {
  if (task.status === 'running' || task.status === 'fixing_with_ai') {
    return true;
  }
  return task.status === 'pending' && task.execution.phase === 'launching';
}
