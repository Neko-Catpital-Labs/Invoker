import type { ExecutorType } from '@invoker/workflow-core';

export interface ExecutingStallEvaluationInput {
  now: Date;
  phase?: 'launching' | 'executing';
  executorType?: ExecutorType;
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
    executorType,
    executingStartedAt,
    leaseExpiresAt,
    executorHeartbeatAt,
    remoteHeartbeatAt,
    executingStallTimeoutMs,
  } = input;
  const heartbeatSource = executorType === 'ssh'
    ? (remoteHeartbeatAt ?? executorHeartbeatAt)
    : executorHeartbeatAt;
  const heartbeatStale =
    !heartbeatSource || now.getTime() - heartbeatSource.getTime() >= executingStallTimeoutMs;
  const leaseExpired = !!leaseExpiresAt && leaseExpiresAt.getTime() < now.getTime();
  const executingAgeMs = executingStartedAt ? now.getTime() - executingStartedAt.getTime() : 0;
  const executingStalled =
    phase === 'executing'
    && executingStartedAt !== undefined
    && executingAgeMs >= executingStallTimeoutMs
    && (leaseExpired || heartbeatStale);

  const staleReason = leaseExpired
    ? 'attempt lease expired'
    : executorType === 'ssh'
    ? 'remote workload heartbeat stale'
    : 'executor heartbeat stale';

  return {
    heartbeatStale,
    leaseExpired,
    executingStalled,
    staleReason,
  };
}
