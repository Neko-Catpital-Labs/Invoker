import { describe, it, expect, beforeEach } from 'vitest';
import { ResponseHandler } from '../response-handler.js';
import type { WorkResponse } from '@invoker/contracts';

describe('ResponseHandler (pure parser)', () => {
  let handler: ResponseHandler;

  beforeEach(() => {
    handler = new ResponseHandler();
  });

  function makeResponse(overrides: Partial<WorkResponse>): WorkResponse {
    return {
      requestId: 'req-1',
      actionId: 't1',
      executionGeneration: 0,
      status: 'completed',
      outputs: { exitCode: 0 },
      ...overrides,
    };
  }

  // ── completed ──────────────────────────────────────────

  describe('completed', () => {
    it('parses a completed response', () => {
      const result = handler.parseResponse(makeResponse({ status: 'completed' }));
      expect('type' in result && result.type === 'completed').toBe(true);
      if (!('type' in result)) return;
      expect(result.type).toBe('completed');
      expect(result.taskId).toBe('t1');
      expect(result.exitCode).toBe(0);
    });

    it('includes summary, commitHash, agentSessionId when present', () => {
      const result = handler.parseResponse(
        makeResponse({
          status: 'completed',
          outputs: { exitCode: 0, summary: 'done', commitHash: 'abc', agentSessionId: 'sess-1' },
        }),
      );
      expect('type' in result).toBe(true);
      if (!('type' in result)) return;
      expect(result).toEqual({
        type: 'completed',
        taskId: 't1',
        exitCode: 0,
        summary: 'done',
        commitHash: 'abc',
        agentSessionId: 'sess-1',
      });
    });
  });

  // ── failed ─────────────────────────────────────────────

  describe('failed', () => {
    it('parses a failed response', () => {
      const result = handler.parseResponse(
        makeResponse({ status: 'failed', outputs: { exitCode: 1, error: 'boom' } }),
      );
      expect('type' in result).toBe(true);
      if (!('type' in result)) return;
      expect(result.type).toBe('failed');
      expect(result.taskId).toBe('t1');
      expect(result.exitCode).toBe(1);
      expect(result.error).toBe('boom');
    });
  });

  // ── needs_input ────────────────────────────────────────

  describe('needs_input', () => {
    it('parses a needs_input response', () => {
      const result = handler.parseResponse(
        makeResponse({ status: 'needs_input', outputs: { summary: 'What now?' } }),
      );
      expect('type' in result).toBe(true);
      if (!('type' in result)) return;
      expect(result.type).toBe('needs_input');
      expect(result.taskId).toBe('t1');
      expect(result.prompt).toBe('What now?');
    });

    it('uses default prompt when summary is missing', () => {
      const result = handler.parseResponse(
        makeResponse({ status: 'needs_input', outputs: {} }),
      );
      expect('type' in result).toBe(true);
      if (!('type' in result)) return;
      expect(result.prompt).toBe('Task requires input');
    });
  });

  // ── spawn_experiments ──────────────────────────────────

  describe('spawn_experiments', () => {
    it('parses variants with prefixed IDs', () => {
      const result = handler.parseResponse(
        makeResponse({
          status: 'spawn_experiments',
          dagMutation: {
            spawnExperiments: {
              description: 'Try variants',
              variants: [
                { id: 'v1', prompt: 'A' },
                { id: 'v2', prompt: 'B' },
              ],
            },
          },
        }),
      );
      expect('type' in result).toBe(true);
      if (!('type' in result)) return;
      expect(result.type).toBe('spawn_experiments');
      expect(result.taskId).toBe('t1');
      expect(result.variants).toHaveLength(2);
      expect(result.variants[0].id).toBe('t1-exp-v1');
      expect(result.variants[1].id).toBe('t1-exp-v2');
    });

    it('uses plan-local pivot id when actionId is workflow-scoped', () => {
      const result = handler.parseResponse(
        makeResponse({
          actionId: 'wf-abc/t1',
          status: 'spawn_experiments',
          dagMutation: {
            spawnExperiments: {
              description: 'Try variants',
              variants: [{ id: 'v1', prompt: 'A' }],
            },
          },
        }),
      );
      expect('type' in result).toBe(true);
      if (!('type' in result)) return;
      expect(result.type).toBe('spawn_experiments');
      expect(result.taskId).toBe('wf-abc/t1');
      expect(result.variants[0].id).toBe('t1-exp-v1');
    });

    it('returns error when dagMutation.spawnExperiments is missing', () => {
      const result = handler.parseResponse(
        makeResponse({ status: 'spawn_experiments' }),
      );
      expect('error' in result).toBe(true);
    });
  });

  // ── select_experiment ──────────────────────────────────

  describe('select_experiment', () => {
    it('parses selected experiment ID', () => {
      const result = handler.parseResponse(
        makeResponse({
          actionId: 'recon',
          status: 'select_experiment',
          dagMutation: { selectExperiment: { experimentId: 'exp1' } },
        }),
      );
      expect('type' in result).toBe(true);
      if (!('type' in result)) return;
      expect(result.type).toBe('select_experiment');
      expect(result.taskId).toBe('recon');
      expect(result.experimentId).toBe('exp1');
    });

    it('returns error when dagMutation.selectExperiment is missing', () => {
      const result = handler.parseResponse(
        makeResponse({ status: 'select_experiment' }),
      );
      expect('error' in result).toBe(true);
    });
  });

  // ── validation ─────────────────────────────────────────

  describe('validation', () => {
    it('rejects invalid response format', () => {
      const result = handler.parseResponse({} as any);
      expect('error' in result).toBe(true);
    });
  });

  // ── malformed payload normalization ────────────────────

  describe('malformed payload normalization', () => {
    it('normalizes null payload into canonical failure envelope', () => {
      const result = handler.parseResponse(null as any);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toBe('WorkResponse must be an object');
        expect(typeof result.error).toBe('string');
      }
    });

    it('normalizes undefined payload into canonical failure envelope', () => {
      const result = handler.parseResponse(undefined as any);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toBe('WorkResponse must be an object');
      }
    });

    it('normalizes string payload into canonical failure envelope', () => {
      const result = handler.parseResponse('not-an-object' as any);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toBe('WorkResponse must be an object');
      }
    });

    it('normalizes number payload into canonical failure envelope', () => {
      const result = handler.parseResponse(123 as any);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toBe('WorkResponse must be an object');
      }
    });

    it('normalizes array payload into canonical failure envelope', () => {
      const result = handler.parseResponse([{ status: 'completed' }] as any);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toBe('WorkResponse must be an object');
      }
    });

    it('normalizes missing requestId into canonical failure envelope', () => {
      const result = handler.parseResponse({ actionId: 'a', status: 'completed', outputs: {} } as any);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toContain('requestId');
        expect(result.error).toContain('required');
      }
    });

    it('normalizes empty requestId into canonical failure envelope', () => {
      const result = handler.parseResponse({ requestId: '', actionId: 'a', status: 'completed', outputs: {} } as any);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toContain('requestId');
        expect(result.error).toContain('non-empty string');
      }
    });

    it('normalizes missing actionId into canonical failure envelope', () => {
      const result = handler.parseResponse({ requestId: 'r', status: 'completed', outputs: {} } as any);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toContain('actionId');
        expect(result.error).toContain('required');
      }
    });

    it('normalizes empty actionId into canonical failure envelope', () => {
      const result = handler.parseResponse({ requestId: 'r', actionId: '', status: 'completed', outputs: {} } as any);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toContain('actionId');
        expect(result.error).toContain('non-empty string');
      }
    });

    it('normalizes unknown status into canonical failure envelope with stable error', () => {
      const result = handler.parseResponse({ requestId: 'r', actionId: 'a', executionGeneration: 0, status: 'unknown_status', outputs: {} } as any);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toContain('status must be one of:');
        expect(result.error).toContain('completed');
        expect(result.error).toContain('failed');
        expect(result.error).toContain('needs_input');
        expect(result.error).toContain('spawn_experiments');
        expect(result.error).toContain('select_experiment');
      }
    });

    it('normalizes typo status into canonical failure envelope', () => {
      const result = handler.parseResponse({ requestId: 'r', actionId: 'a', executionGeneration: 0, status: 'complted', outputs: {} } as any);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toContain('status must be one of:');
      }
    });

    it('normalizes missing outputs field into canonical failure envelope', () => {
      const result = handler.parseResponse({ requestId: 'r', actionId: 'a', executionGeneration: 0, status: 'completed' } as any);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toBe('outputs is required and must be an object');
      }
    });

    it('normalizes null outputs into canonical failure envelope', () => {
      const result = handler.parseResponse({ requestId: 'r', actionId: 'a', executionGeneration: 0, status: 'completed', outputs: null } as any);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toBe('outputs is required and must be an object');
      }
    });

    it('normalizes non-object outputs into canonical failure envelope', () => {
      const result = handler.parseResponse({ requestId: 'r', actionId: 'a', executionGeneration: 0, status: 'completed', outputs: 'string' } as any);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toBe('outputs is required and must be an object');
      }
    });

    // Regression: if the Array.isArray(r.outputs) guard is removed, the `completed`
    // branch would run `outputs.exitCode ?? 0` and emit a `{ type: 'completed' }`
    // envelope for a payload whose outputs were never a valid object. This test
    // locks in both the error path AND the absence of the success path.
    it('normalizes array outputs into canonical failure envelope and does NOT emit completed', () => {
      const result = handler.parseResponse({ requestId: 'r', actionId: 'a', executionGeneration: 0, status: 'completed', outputs: [] } as any);
      expect('error' in result).toBe(true);
      expect('type' in result).toBe(false);
      if ('error' in result) {
        expect(result.error).toBe('outputs is required and must be an object');
      }
    });

    it('normalizes spawn_experiments without dagMutation into canonical failure envelope', () => {
      const result = handler.parseResponse({ requestId: 'r', actionId: 'a', executionGeneration: 0, status: 'spawn_experiments', outputs: {} } as any);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toBe('spawn_experiments status requires dagMutation.spawnExperiments');
      }
    });

    it('normalizes spawn_experiments with null dagMutation into canonical failure envelope', () => {
      const result = handler.parseResponse({ requestId: 'r', actionId: 'a', executionGeneration: 0, status: 'spawn_experiments', outputs: {}, dagMutation: null } as any);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toBe('spawn_experiments status requires dagMutation.spawnExperiments');
      }
    });

    it('normalizes spawn_experiments with empty dagMutation into canonical failure envelope', () => {
      const result = handler.parseResponse({ requestId: 'r', actionId: 'a', executionGeneration: 0, status: 'spawn_experiments', outputs: {}, dagMutation: {} } as any);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toBe('spawn_experiments status requires dagMutation.spawnExperiments');
      }
    });

    it('normalizes select_experiment without dagMutation into canonical failure envelope', () => {
      const result = handler.parseResponse({ requestId: 'r', actionId: 'a', executionGeneration: 0, status: 'select_experiment', outputs: {} } as any);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toBe('select_experiment status requires dagMutation.selectExperiment');
      }
    });

    it('normalizes select_experiment with null dagMutation into canonical failure envelope', () => {
      const result = handler.parseResponse({ requestId: 'r', actionId: 'a', executionGeneration: 0, status: 'select_experiment', outputs: {}, dagMutation: null } as any);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toBe('select_experiment status requires dagMutation.selectExperiment');
      }
    });

    it('normalizes select_experiment with empty dagMutation into canonical failure envelope', () => {
      const result = handler.parseResponse({ requestId: 'r', actionId: 'a', executionGeneration: 0, status: 'select_experiment', outputs: {}, dagMutation: {} } as any);
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toBe('select_experiment status requires dagMutation.selectExperiment');
      }
    });

    it('ensures all failure envelopes have consistent structure (error: string)', () => {
      const malformedInputs = [
        null,
        undefined,
        'string',
        42,
        [],
        {},
        { requestId: 'r' },
        { requestId: 'r', actionId: 'a' },
        { requestId: 'r', actionId: 'a', executionGeneration: 0, status: 'unknown' },
        { requestId: 'r', actionId: 'a', executionGeneration: 0, status: 'completed' },
        { requestId: 'r', actionId: 'a', executionGeneration: 0, status: 'spawn_experiments', outputs: {} },
        { requestId: 'r', actionId: 'a', executionGeneration: 0, status: 'select_experiment', outputs: {} },
      ];

      malformedInputs.forEach((input) => {
        const result = handler.parseResponse(input as any);
        expect('error' in result).toBe(true);
        if ('error' in result) {
          expect(typeof result.error).toBe('string');
          expect(result.error.length).toBeGreaterThan(0);
          expect(Object.keys(result)).toEqual(['error']);
        }
      });
    });

    it('ensures canonical envelopes are deterministic and stable', () => {
      const input = { requestId: 'r', actionId: 'a', executionGeneration: 0, status: 'unknown_status', outputs: {} };
      const result1 = handler.parseResponse(input as any);
      const result2 = handler.parseResponse(input as any);

      expect(result1).toEqual(result2);
      expect('error' in result1 && 'error' in result2).toBe(true);
      if ('error' in result1 && 'error' in result2) {
        expect(result1.error).toBe(result2.error);
      }
    });

    it('verifies error messages are suitable for orchestrator consumption', () => {
      // Orchestrator needs clear, actionable error messages
      const cases = [
        { input: null, expectedSubstring: 'must be an object' },
        { input: { requestId: 'r' }, expectedSubstring: 'actionId' },
        { input: { requestId: 'r', actionId: 'a', executionGeneration: 0 }, expectedSubstring: 'status' },
        { input: { requestId: 'r', actionId: 'a', executionGeneration: 0, status: 'completed' }, expectedSubstring: 'outputs' },
        { input: { requestId: 'r', actionId: 'a', executionGeneration: 0, status: 'spawn_experiments', outputs: {} }, expectedSubstring: 'spawnExperiments' },
      ];

      cases.forEach(({ input, expectedSubstring }) => {
        const result = handler.parseResponse(input as any);
        expect('error' in result).toBe(true);
        if ('error' in result) {
          expect(result.error).toContain(expectedSubstring);
          // Error should be clear and not overly verbose
          expect(result.error.length).toBeLessThan(200);
        }
      });
    });
  });

  // ── no state mutation ──────────────────────────────────

  describe('purity', () => {
    it('does not require any constructor dependencies', () => {
      const h = new ResponseHandler();
      expect(h).toBeDefined();
    });

    it('returns data without side effects', () => {
      const r1 = handler.parseResponse(makeResponse({ status: 'completed' }));
      const r2 = handler.parseResponse(makeResponse({ status: 'completed' }));
      expect(r1).toEqual(r2);
    });
  });
});
