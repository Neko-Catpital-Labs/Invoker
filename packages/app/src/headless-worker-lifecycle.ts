import type { WorkerStatusEntry } from '@invoker/contracts';

/**
 * Render a worker's lifecycle for operator-facing output.
 *
 * A snapshot built outside the owner process omits `running` because it cannot
 * observe runtime liveness. Its `lifecycle` field still defaults to `stopped`,
 * which reads as "this worker is off" when the truth is "not known from here".
 */
export function renderWorkerLifecycle(
  worker: Pick<WorkerStatusEntry, 'lifecycle'> & { running?: boolean },
): string {
  return worker.running === undefined ? 'unknown' : worker.lifecycle;
}
