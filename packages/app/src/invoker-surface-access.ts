import {
  resolveDefaultTaskExecutionSettings,
  resolveEnabledExecutionAgents,
  type InvokerConfig,
} from './config.js';

export const INVOKER_SURFACE_ACCESS_DENIAL_CODE = 'execution_agent_disabled' as const;

export type InvokerSurfaceAccessDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly code: typeof INVOKER_SURFACE_ACCESS_DENIAL_CODE;
      readonly message: string;
    };

export function checkInvokerSurfaceAccess(
  config: InvokerConfig,
  executionAgent?: string,
): InvokerSurfaceAccessDecision {
  const requestedAgent = executionAgent?.trim();
  const effectiveAgent = requestedAgent || resolveDefaultTaskExecutionSettings(config).executionAgent;
  const enabledAgents = resolveEnabledExecutionAgents(config);

  if (!enabledAgents || enabledAgents.has(effectiveAgent.toLowerCase())) {
    return { allowed: true };
  }

  return {
    allowed: false,
    code: INVOKER_SURFACE_ACCESS_DENIAL_CODE,
    message: `Execution agent "${effectiveAgent}" is disabled by deployment configuration`,
  };
}
