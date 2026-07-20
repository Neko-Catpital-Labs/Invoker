import type { Logger } from '@invoker/contracts';
import type { TaskRunner } from '@invoker/execution-engine';

export interface ReviewGateStatusWorker {
  tick(): Promise<void>;
  stop(): void;
}

export interface ReviewGateStatusWorkerOptions {
  ownerMode: boolean;
  getTaskExecutor: () => Pick<TaskRunner, 'checkMergeGateStatuses'>;
  logger: Logger;
  intervalMs?: number;
}

const DEFAULT_REVIEW_GATE_STATUS_WORKER_INTERVAL_MS = 60_000;

export function startReviewGateStatusWorker(
  options: ReviewGateStatusWorkerOptions,
): ReviewGateStatusWorker | null {
  if (!options.ownerMode) {
    options.logger.info('review-gate status worker disabled outside owner mode', { module: 'merge-gate' });
    return null;
  }

  const intervalMs = options.intervalMs ?? DEFAULT_REVIEW_GATE_STATUS_WORKER_INTERVAL_MS;
  let stopped = false;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (inFlight) {
      options.logger.info('review-gate status worker tick skipped because previous tick is still running', {
        module: 'merge-gate',
      });
      return;
    }
    inFlight = true;
    try {
      await options.getTaskExecutor().checkMergeGateStatuses();
    } catch (err) {
      options.logger.error('review-gate status worker tick failed', { module: 'merge-gate', err });
    } finally {
      inFlight = false;
    }
  };

  const interval = setInterval(() => {
    void tick();
  }, intervalMs);
  interval.unref?.();

  options.logger.info(`review-gate status worker started intervalMs=${intervalMs}`, { module: 'merge-gate' });

  return {
    tick,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      options.logger.info('review-gate status worker stopped', { module: 'merge-gate' });
    },
  };
}
