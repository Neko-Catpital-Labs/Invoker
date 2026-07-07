import type { InvokerConfig, MachineCapabilities } from './config.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function validateModelPolicy(path: string, policy: unknown): void {
  if (!isRecord(policy)) {
    throw new Error(`${path}: expected modelPolicy object`);
  }

  const kind = policy.kind;
  if (kind === 'implicit') {
    if ('model' in policy || 'models' in policy || 'defaultModel' in policy) {
      throw new Error(`${path}: implicit policies must not include model, models, or defaultModel`);
    }
    return;
  }

  if (kind === 'fixed') {
    if (!readNonEmptyString(policy.model)) {
      throw new Error(`${path}.model: expected a non-empty string`);
    }
    return;
  }

  if (kind === 'select') {
    if (!Array.isArray(policy.models) || policy.models.length === 0) {
      throw new Error(`${path}.models: expected a non-empty array of non-empty strings`);
    }
    const models = policy.models.map((model, index) => {
      const value = readNonEmptyString(model);
      if (!value) {
        throw new Error(`${path}.models[${index}]: expected a non-empty string`);
      }
      return value;
    });
    const defaultModel = readNonEmptyString(policy.defaultModel);
    if (!defaultModel) {
      throw new Error(`${path}.defaultModel: expected a non-empty string`);
    }
    if (!models.includes(defaultModel)) {
      throw new Error(`${path}.defaultModel: expected one of models`);
    }
    return;
  }

  throw new Error(`${path}.kind: expected "implicit", "fixed", or "select"`);
}

function validateRoleHarnesses(
  label: string,
  role: 'planning' | 'execution',
  harnesses: Record<string, unknown>,
): void {
  for (const [harness, capability] of Object.entries(harnesses)) {
    const harnessPath = `${label}.${role}.${harness}`;
    if (role === 'execution' && harness === 'cursor') {
      throw new Error(`${harnessPath}: cursor is planning-only`);
    }
    if (role === 'planning' && (harness === 'claude' || harness === 'codex')) {
      throw new Error(`${harnessPath}: ${harness} is execution-only`);
    }
    if (!isRecord(capability)) {
      throw new Error(`${harnessPath}: expected harness capability object`);
    }
    validateModelPolicy(`${harnessPath}.modelPolicy`, capability.modelPolicy);
  }
}

function validateMachineCapabilities(label: string, capabilities: MachineCapabilities): void {
  const rawCapabilities = capabilities as unknown;
  if (!isRecord(rawCapabilities)) {
    throw new Error(`${label}: expected capabilities object`);
  }

  const planning = rawCapabilities.planning;
  if (planning !== undefined) {
    if (!isRecord(planning)) {
      throw new Error(`${label}.planning: expected a harness map`);
    }
    validateRoleHarnesses(label, 'planning', planning);
  }

  const execution = rawCapabilities.execution;
  if (execution !== undefined) {
    if (!isRecord(execution)) {
      throw new Error(`${label}.execution: expected a harness map`);
    }
    validateRoleHarnesses(label, 'execution', execution);
  }
}

export function validateInvokerConfig(config: InvokerConfig): InvokerConfig {
  const defaultExecutionAgent = readNonEmptyString(config.defaultExecution?.executionAgent);
  if (config.defaultExecution?.executionModel !== undefined && !defaultExecutionAgent) {
    throw new Error('defaultExecution.executionModel requires defaultExecution.executionAgent');
  }

  for (const [targetId, target] of Object.entries(config.remoteTargets ?? {})) {
    if (target.capabilities) {
      validateMachineCapabilities(`remoteTargets.${targetId}.capabilities`, target.capabilities);
    }
  }

  for (const [poolId, pool] of Object.entries(config.executionPools ?? {})) {
    pool.members.forEach((member, index) => {
      if (member.capabilities) {
        validateMachineCapabilities(
          `executionPools.${poolId}.members[${index}].capabilities`,
          member.capabilities,
        );
      }
    });
  }

  return config;
}
