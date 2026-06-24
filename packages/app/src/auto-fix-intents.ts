/**
 * Compatibility shim. Auto-fix intent helpers now live in
 * `@invoker/execution-engine`; this re-export keeps `./auto-fix-intents.js`
 * import paths working for app code and tests unchanged.
 */
export * from '@invoker/execution-engine';
