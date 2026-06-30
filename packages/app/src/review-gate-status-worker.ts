/**
 * Compatibility shim. Review-gate PR status polling is now the pr-status
 * worker in `@invoker/execution-engine`.
 */
export {
  createPrStatusWorker,
  DEFAULT_PR_STATUS_WORKER_INTERVAL_MS,
  PR_STATUS_WORKER_KIND,
  type PrStatusWorkerOptions,
  type PrStatusWorkerReviewGateDeps,
} from '@invoker/execution-engine';
