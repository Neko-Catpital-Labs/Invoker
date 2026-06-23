/**
 * Re-export shim. The auto-fix gating helper now lives in
 * `@invoker/execution-engine`. This file keeps every previous
 * `./auto-fix-gating.js` import in `@invoker/app` resolving unchanged.
 */
export { shouldSkipAutoFixForError } from '@invoker/execution-engine';
