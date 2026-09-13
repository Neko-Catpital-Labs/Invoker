import { describe, expect, it } from 'vitest';
import { assertExecutionModelSupported, type ExecutionAgent } from '../agent.js';

const supportedModels = [{ id: 'gpt-5', label: 'GPT-5' }];
const currentWording =
  'Execution model "claude" is not supported for execution agent "codex". Known models: [gpt-5].';

function rejectionMessage(agent: Pick<ExecutionAgent, 'name' | 'supportedModels' | 'supportsModel' | 'supportedModelsProvenance'>): string {
  try {
    assertExecutionModelSupported(agent, 'claude');
    throw new Error('expected model rejection');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('model rejection provenance', () => {
  it('keeps today\'s wording when the agent answered', () => {
    const agent = {
      name: 'codex',
      supportedModels,
      supportedModelsProvenance: 'agent' as const,
    };

    expect(rejectionMessage(agent)).toBe(currentWording);
  });

  it('marks built-in model lists as a fallback', () => {
    const agent = {
      name: 'codex',
      supportedModels,
      supportedModelsProvenance: 'built-in' as const,
    };

    expect(rejectionMessage(agent)).toContain('built-in fallback');
    expect(rejectionMessage(agent)).toContain('live discovery was unavailable');
    expect(rejectionMessage(agent)).not.toBe(currentWording);
  });

  it('keeps today\'s wording when provenance is absent', () => {
    const agent = { name: 'codex', supportedModels };

    expect(rejectionMessage(agent)).toBe(currentWording);
  });
});
