import { describe, it, expect } from 'vitest';
import { validateWorkRequest, validateWorkResponse } from '../validation.js';
import { createWorkRequest } from '../types.js';
import type { WorkResponse } from '../types.js';

describe('validateWorkRequest', () => {
  it('accepts a valid WorkRequest', () => {
    const req = createWorkRequest('req-1', 'task-1', 0, 'command', { command: 'echo hi' }, 'http://localhost:4000/callback');
    const result = validateWorkRequest(req);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('rejects non-object input', () => {
    expect(validateWorkRequest(null).valid).toBe(false);
    expect(validateWorkRequest('string').valid).toBe(false);
    expect(validateWorkRequest(42).valid).toBe(false);
  });

  it('rejects missing requestId', () => {
    const result = validateWorkRequest({ actionId: 'a', executionGeneration: 0, actionType: 'command', inputs: {}, callbackUrl: 'http://x' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('requestId');
  });

  it('rejects invalid actionType', () => {
    const result = validateWorkRequest({ requestId: 'r', actionId: 'a', executionGeneration: 0, actionType: 'invalid', inputs: {}, callbackUrl: 'http://x' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('actionType');
  });
});

describe('validateWorkResponse', () => {
  const baseResponse: WorkResponse = {
    requestId: 'req-1',
    actionId: 'task-1',
    executionGeneration: 0,
    status: 'completed',
    outputs: { exitCode: 0 },
  };

  it('accepts a valid completed response', () => {
    const result = validateWorkResponse(baseResponse);
    expect(result.valid).toBe(true);
  });

  it('accepts a valid spawn_experiments response with dagMutation', () => {
    const res: WorkResponse = {
      ...baseResponse,
      status: 'spawn_experiments',
      dagMutation: {
        spawnExperiments: {
          description: 'test',
          variants: [{ id: 'v1', prompt: 'try this' }],
        },
      },
    };
    const result = validateWorkResponse(res);
    expect(result.valid).toBe(true);
  });

  it('rejects missing requestId', () => {
    const result = validateWorkResponse({ actionId: 'a', status: 'completed', outputs: {} });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('requestId');
  });

  it('rejects spawn_experiments without dagMutation', () => {
    const res = { ...baseResponse, status: 'spawn_experiments' };
    const result = validateWorkResponse(res);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('spawnExperiments');
  });

  it('rejects select_experiment without dagMutation', () => {
    const res = { ...baseResponse, status: 'select_experiment' };
    const result = validateWorkResponse(res);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('selectExperiment');
  });

  describe('malformed payload normalization', () => {
    it('rejects null payload with deterministic error', () => {
      const result = validateWorkResponse(null);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('WorkResponse must be an object');
    });

    it('rejects undefined payload with deterministic error', () => {
      const result = validateWorkResponse(undefined);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('WorkResponse must be an object');
    });

    it('rejects string payload with deterministic error', () => {
      const result = validateWorkResponse('malformed');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('WorkResponse must be an object');
    });

    it('rejects number payload with deterministic error', () => {
      const result = validateWorkResponse(42);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('WorkResponse must be an object');
    });

    it('rejects array payload with deterministic error', () => {
      const result = validateWorkResponse([{ status: 'completed' }]);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('WorkResponse must be an object');
    });

    it('rejects empty requestId', () => {
      const result = validateWorkResponse({ requestId: '', actionId: 'a', status: 'completed', outputs: {} });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('requestId');
      expect(result.error).toContain('non-empty string');
    });

    it('rejects missing actionId', () => {
      const result = validateWorkResponse({ requestId: 'r', status: 'completed', outputs: {} });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('actionId');
    });

    it('rejects empty actionId', () => {
      const result = validateWorkResponse({ requestId: 'r', actionId: '', status: 'completed', outputs: {} });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('actionId');
      expect(result.error).toContain('non-empty string');
    });

    it('rejects unknown status with stable error listing valid statuses', () => {
      const result = validateWorkResponse({ requestId: 'r', actionId: 'a', status: 'unknown_status', outputs: {} });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('status must be one of:');
      expect(result.error).toContain('completed');
      expect(result.error).toContain('failed');
      expect(result.error).toContain('needs_input');
      expect(result.error).toContain('spawn_experiments');
      expect(result.error).toContain('select_experiment');
    });

    it('rejects missing outputs field', () => {
      const result = validateWorkResponse({ requestId: 'r', actionId: 'a', status: 'completed' });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('outputs is required and must be an object');
    });

    it('rejects null outputs', () => {
      const result = validateWorkResponse({ requestId: 'r', actionId: 'a', status: 'completed', outputs: null });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('outputs is required and must be an object');
    });

    it('rejects non-object outputs', () => {
      const result = validateWorkResponse({ requestId: 'r', actionId: 'a', status: 'completed', outputs: 'not-an-object' });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('outputs is required and must be an object');
    });

    // Regression: arrays pass `typeof === 'object'`. Without the Array.isArray(r.outputs)
    // guard, `outputs: []` would reach the orchestrator's completed branch where
    // `outputs.exitCode ?? 0` silently produces an apparently-successful task state.
    it('rejects array outputs (silent-corruption guard)', () => {
      const result = validateWorkResponse({ requestId: 'r', actionId: 'a', status: 'completed', outputs: [] });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('outputs is required and must be an object');
    });

    it('rejects spawn_experiments with missing dagMutation', () => {
      const result = validateWorkResponse({ requestId: 'r', actionId: 'a', status: 'spawn_experiments', outputs: {} });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('spawn_experiments status requires dagMutation.spawnExperiments');
    });

    it('rejects spawn_experiments with null dagMutation', () => {
      const result = validateWorkResponse({ requestId: 'r', actionId: 'a', status: 'spawn_experiments', outputs: {}, dagMutation: null });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('spawn_experiments status requires dagMutation.spawnExperiments');
    });

    it('rejects spawn_experiments with empty dagMutation', () => {
      const result = validateWorkResponse({ requestId: 'r', actionId: 'a', status: 'spawn_experiments', outputs: {}, dagMutation: {} });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('spawn_experiments status requires dagMutation.spawnExperiments');
    });

    it('rejects select_experiment with missing dagMutation', () => {
      const result = validateWorkResponse({ requestId: 'r', actionId: 'a', status: 'select_experiment', outputs: {} });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('select_experiment status requires dagMutation.selectExperiment');
    });

    it('rejects select_experiment with null dagMutation', () => {
      const result = validateWorkResponse({ requestId: 'r', actionId: 'a', status: 'select_experiment', outputs: {}, dagMutation: null });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('select_experiment status requires dagMutation.selectExperiment');
    });

    it('rejects select_experiment with empty dagMutation', () => {
      const result = validateWorkResponse({ requestId: 'r', actionId: 'a', status: 'select_experiment', outputs: {}, dagMutation: {} });
      expect(result.valid).toBe(false);
      expect(result.error).toBe('select_experiment status requires dagMutation.selectExperiment');
    });
  });
});
