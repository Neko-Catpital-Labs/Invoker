/**
 * Compatibility shim. The worker runtime now lives in
 * `@invoker/execution-engine`; this re-export keeps `./worker-runtime.js`
 * import paths working for app code and tests unchanged.
 */
export * from '@invoker/execution-engine';
