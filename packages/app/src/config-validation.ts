import type { InvokerConfig } from './config.js';

export function validateInvokerConfig(config: InvokerConfig): InvokerConfig {
  const executionAgent = config.defaultExecution?.executionAgent;
  const hasExecutionAgent = typeof executionAgent === 'string' && executionAgent.trim().length > 0;
  if (config.defaultExecution?.executionModel !== undefined && !hasExecutionAgent) {
    throw new Error('defaultExecution.executionModel requires defaultExecution.executionAgent');
  }

  return config;
}
