/**
 * Re-export shim. The auto-fix intent helpers now live in
 * `@invoker/execution-engine`. This file keeps every previous
 * `./auto-fix-intents.js` import in `@invoker/app` resolving unchanged.
 */
export {
  isFixIntentForTask,
  listOpenFixIntentsForTask,
  hasOpenFixIntentForTask,
  encodeReviewGateCiContext,
  decodeReviewGateCiContext,
  isReviewGateCiContextStale,
  parseHeadlessFixArgs,
  buildHeadlessFixArgs,
  buildFixWithAgentMutationArgs,
  parseFixWithAgentMutationArgs,
} from '@invoker/execution-engine';

export type {
  ReviewGateCiContext,
  ReviewGateLineageFields,
  AutoFixCommandContext,
  ParsedHeadlessFixArgs,
  FixWithAgentMutationOptions,
  ParsedFixWithAgentMutationArgs,
} from '@invoker/execution-engine';
