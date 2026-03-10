import { describe, it, expect } from 'vitest';
import { validateWorkRequest, validateWorkResponse } from '../validation.js';
import { createWorkRequest } from '../types.js';
import type { WorkResponse } from '../types.js';

describe('validateWorkRequest', () => {
  it('accepts a valid WorkRequest', () => {
    const req = createWorkRequest('req-1', 'task-1', 'command', { command: 'echo hi' }, 'http://localhost:4000/callback');
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
    const result = validateWorkRequest({ actionId: 'a', actionType: 'command', inputs: {}, callbackUrl: 'http://x' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('requestId');
  });

  it('rejects invalid actionType', () => {
    const result = validateWorkRequest({ requestId: 'r', actionId: 'a', actionType: 'invalid', inputs: {}, callbackUrl: 'http://x' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('actionType');
  });
});

describe('validateWorkResponse', () => {
  const baseResponse: WorkResponse = {
    requestId: 'req-1',
    actionId: 'task-1',
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
});
