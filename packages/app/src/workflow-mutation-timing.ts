import type { Logger } from '@invoker/contracts';
import type { SQLiteAdapter } from '@invoker/data-store';

type TimingPhase = 'queued' | 'started' | 'completed' | 'failed' | 'evicted' | 'invalidated';

export interface WorkflowMutationTiming {
  readonly workflowId: string;
  readonly channel: string;
  readonly intentId?: number;
  mark(functionName: string, phase: TimingPhase, metadata?: Record<string, unknown>): void;
  span<T>(functionName: string, metadata: Record<string, unknown> | undefined, fn: () => Promise<T>): Promise<T>;
}

export function createWorkflowMutationTiming(args: {
  persistence: SQLiteAdapter;
  logger?: Logger;
  workflowId: string;
  channel: string;
  intentId?: number;
  args?: unknown[];
}): WorkflowMutationTiming {
  const startedAtMs = Date.now();
  const eventTaskId = findWorkflowEventTaskId(args.persistence, args.workflowId);
  const base = {
    workflowId: args.workflowId,
    channel: args.channel,
    intentId: args.intentId,
    traceId: extractTraceId(args.args),
  };

  const record = (
    functionName: string,
    phase: TimingPhase,
    metadata?: Record<string, unknown>,
  ): void => {
    const nowMs = Date.now();
    const payload = compact({
      ...base,
      function: functionName,
      phase,
      at: new Date(nowMs).toISOString(),
      offsetMs: nowMs - startedAtMs,
      ...metadata,
    });
    args.logger?.info(
      `[workflow-mutation-timing] ${functionName} ${phase}`,
      { module: 'workflow-mutation-timing', ...payload },
    );
    if (!eventTaskId) return;
    try {
      args.persistence.logEvent(eventTaskId, 'workflow.mutation.timing', payload);
    } catch (error) {
      args.logger?.warn('[workflow-mutation-timing] failed to persist event', {
        module: 'workflow-mutation-timing',
        error: error instanceof Error ? error.message : String(error),
        workflowId: args.workflowId,
        function: functionName,
        phase,
      });
    }
  };

  return {
    workflowId: args.workflowId,
    channel: args.channel,
    intentId: args.intentId,
    mark: record,
    async span<T>(
      functionName: string,
      metadata: Record<string, unknown> | undefined,
      fn: () => Promise<T>,
    ): Promise<T> {
      const spanStartedAtMs = Date.now();
      record(functionName, 'started', metadata);
      try {
        const result = await fn();
        record(functionName, 'completed', {
          ...metadata,
          durationMs: Date.now() - spanStartedAtMs,
        });
        return result;
      } catch (error) {
        record(functionName, 'failed', {
          ...metadata,
          durationMs: Date.now() - spanStartedAtMs,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}

function findWorkflowEventTaskId(persistence: SQLiteAdapter, workflowId: string): string | undefined {
  try {
    const tasks = persistence.loadTasks(workflowId);
    return tasks.find((task) => task.config.isMergeNode)?.id ?? tasks[0]?.id;
  } catch {
    return undefined;
  }
}

function extractTraceId(args: unknown[] | undefined): string | undefined {
  const first = args?.[0];
  if (!first || typeof first !== 'object') return undefined;
  const traceId = (first as { traceId?: unknown }).traceId;
  return typeof traceId === 'string' && traceId.trim() ? traceId : undefined;
}

function compact(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  );
}
