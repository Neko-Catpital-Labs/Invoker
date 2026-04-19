import { describe, it, expect } from 'vitest';
import { serializeWorkflow, formatWorkflowList } from '../formatter.js';
import type { Workflow } from '@invoker/data-store';

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-1',
    name: 'Test Workflow',
    status: 'completed',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:02:00.000Z',
    ...overrides,
  };
}

describe('workflow duration tracking', () => {
  describe('serializeWorkflow', () => {
    it('includes startedAt and completedAt when present', () => {
      const wf = makeWorkflow({
        startedAt: '2024-01-01T00:00:05.000Z',
        completedAt: '2024-01-01T00:02:05.000Z',
      });
      const result = serializeWorkflow(wf);
      expect(result.startedAt).toBe('2024-01-01T00:00:05.000Z');
      expect(result.completedAt).toBe('2024-01-01T00:02:05.000Z');
    });

    it('computes durationMs from startedAt to completedAt', () => {
      const wf = makeWorkflow({
        startedAt: '2024-01-01T00:00:00.000Z',
        completedAt: '2024-01-01T00:01:30.000Z',
      });
      const result = serializeWorkflow(wf);
      expect(result.durationMs).toBe(90_000);
    });

    it('omits durationMs when startedAt is missing', () => {
      const wf = makeWorkflow({ completedAt: '2024-01-01T00:01:00.000Z' });
      const result = serializeWorkflow(wf);
      expect(result.durationMs).toBeUndefined();
    });

    it('omits durationMs when completedAt is missing', () => {
      const wf = makeWorkflow({ startedAt: '2024-01-01T00:00:00.000Z' });
      const result = serializeWorkflow(wf);
      expect(result.durationMs).toBeUndefined();
    });

    it('omits startedAt and completedAt when not set', () => {
      const wf = makeWorkflow();
      const result = serializeWorkflow(wf);
      expect(result.startedAt).toBeUndefined();
      expect(result.completedAt).toBeUndefined();
    });
  });

  describe('formatWorkflowList', () => {
    it('shows duration in seconds when both timestamps present', () => {
      const wf = makeWorkflow({
        startedAt: '2024-01-01T00:00:00.000Z',
        completedAt: '2024-01-01T00:00:45.000Z',
      });
      const output = formatWorkflowList([wf]);
      expect(output).toContain('45s');
    });

    it('shows duration in minutes when over 60s', () => {
      const wf = makeWorkflow({
        startedAt: '2024-01-01T00:00:00.000Z',
        completedAt: '2024-01-01T00:02:30.000Z',
      });
      const output = formatWorkflowList([wf]);
      expect(output).toContain('2m 30s');
    });

    it('omits duration when timestamps are missing', () => {
      const wf = makeWorkflow();
      const output = formatWorkflowList([wf]);
      expect(output).not.toMatch(/\d+s/);
    });
  });
});
