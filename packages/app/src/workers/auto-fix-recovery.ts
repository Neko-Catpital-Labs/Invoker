/**
 * Compatibility shim. The auto-fix recovery engine now lives in
 * `@invoker/execution-engine`; this re-export keeps `./workers/auto-fix-recovery.js`
 * import paths (including `RECOVERY_WORKER_KIND` and the engine factories)
 * working for app code and tests unchanged.
 */
export * from '@invoker/execution-engine';
