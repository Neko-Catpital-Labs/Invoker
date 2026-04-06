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
