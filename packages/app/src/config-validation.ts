import { assertExecutionModelSupported, registerBuiltinAgents } from '@invoker/execution-engine';
import { normalizeGithubOwnerRepo, type InvokerConfig } from './config.js';

const builtinAgents = registerBuiltinAgents();

function validateConfiguredModel(agentName: string | undefined, executionModel: string | undefined): void {
  const normalizedAgent = agentName?.trim();
  const normalizedModel = executionModel?.trim();
  if (!normalizedAgent || !normalizedModel) return;
  const agent = builtinAgents.get(normalizedAgent);
  if (!agent) return;
  assertExecutionModelSupported(agent, normalizedModel);
}

function validatePrMaintenanceTargetRepos(config: InvokerConfig): void {
  const targetRepos = config.prMaintenance?.targetRepos;
  if (targetRepos === undefined) return;
  if (!Array.isArray(targetRepos)) {
    throw new Error('prMaintenance.targetRepos must be an array of "owner/repo" strings');
  }
  for (const entry of targetRepos) {
    if (typeof entry !== 'string' || !normalizeGithubOwnerRepo(entry)) {
      throw new Error(
        `prMaintenance.targetRepos entries must be "owner/repo" strings; got ${JSON.stringify(entry)}`,
      );
    }
  }
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

  if (config.enabledExecutionAgents !== undefined) {
    if (!Array.isArray(config.enabledExecutionAgents)) {
      throw new Error('enabledExecutionAgents must be an array of agent names');
    }
    for (const entry of config.enabledExecutionAgents) {
      if (typeof entry !== 'string' || entry.trim().length === 0) {
        throw new Error('enabledExecutionAgents entries must be non-empty strings');
      }
    }
  }

  validateConfiguredModel(config.defaultExecution?.executionAgent, config.defaultExecution?.executionModel);
  validateConfiguredModel(config.defaultExecutionAgent, config.defaultExecutionModel);
  validatePrMaintenanceTargetRepos(config);
  return config;
}
