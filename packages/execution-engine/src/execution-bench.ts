import type { Logger } from '@invoker/contracts';
import { executionTraceEnabled, traceExecution } from './exec-trace.js';

export const EXECUTE_TASK_BENCH_ENV = 'INVOKER_BENCH_EXECUTE_TASK';

export function executionBenchEnabled(): boolean {
  return process.env[EXECUTE_TASK_BENCH_ENV] === '1' || executionTraceEnabled();
}

export function createExecutionBench({
  module,
  logger,
  baseMetadata = {},
}: {
  module: string;
  logger?: Logger;
  baseMetadata?: Record<string, unknown>;
}): (phase: string, metadata?: Record<string, unknown>) => void {
  if (!executionBenchEnabled()) return () => {};
  const startedAt = Date.now();
  let previousAt = startedAt;

  return (phase, metadata = {}) => {
    const now = Date.now();
    const elapsedMs = now - startedAt;
    const deltaMs = now - previousAt;
    previousAt = now;
    const payload = {
      module,
      phase,
      elapsedMs,
      deltaMs,
      ...baseMetadata,
      ...metadata,
    };
    const message = `[${module}] phase="${phase}" elapsedMs=${elapsedMs} deltaMs=${deltaMs}`;
    if (logger) {
      logger.info(message, payload);
    } else {
      console.info(message, payload);
    }
    traceExecution(message);
  };
}
