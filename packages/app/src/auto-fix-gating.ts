/**
 * Compatibility shim. Auto-fix gating now lives in
 * `@invoker/execution-engine`; this re-export keeps `./auto-fix-gating.js`
 * import paths working for app code and tests unchanged.
 */
export * from '@invoker/execution-engine';
