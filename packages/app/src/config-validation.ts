import { assertExecutionModelSupported, registerBuiltinAgents } from '@invoker/execution-engine';
import type { InvokerConfig } from './config.js';

const builtinAgents = registerBuiltinAgents();

function validateConfiguredModel(agentName: string | undefined, executionModel: string | undefined): void {
  const normalizedAgent = agentName?.trim();
  const normalizedModel = executionModel?.trim();
  if (!normalizedAgent || !normalizedModel) return;
  const agent = builtinAgents.get(normalizedAgent);
  if (!agent) return;
  assertExecutionModelSupported(agent, normalizedModel);
}

export function validateInvokerConfig(config: InvokerConfig): InvokerConfig {
  const nestedExecutionAgent = config.defaultExecution?.executionAgent;
  const hasNestedExecutionAgent = typeof nestedExecutionAgent === 'string' && nestedExecutionAgent.trim().length > 0;
  if (config.defaultExecution?.executionModel !== undefined && !hasNestedExecutionAgent) {
    throw new Error('defaultExecution.executionModel requires defaultExecution.executionAgent');
  }

  const flatExecutionAgent = config.defaultExecutionAgent;
  const hasFlatExecutionAgent = typeof flatExecutionAgent === 'string' && flatExecutionAgent.trim().length > 0;
  if (config.defaultExecutionModel !== undefined && !hasFlatExecutionAgent) {
    throw new Error('defaultExecutionModel requires defaultExecutionAgent');
  }

  validateConfiguredModel(config.defaultExecution?.executionAgent, config.defaultExecution?.executionModel);
  validateConfiguredModel(config.defaultExecutionAgent, config.defaultExecutionModel);
  return config;
}
