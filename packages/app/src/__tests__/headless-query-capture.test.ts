import { describe, it, expect, vi } from 'vitest';
import {
  runReadOnlyHeadlessQueryToString,
  type HeadlessQueryDeps,
} from '../headless-query-list.js';

function makeQueryDeps(listWorkflows: () => Array<{ id: string; status?: string }>): HeadlessQueryDeps {
  return {
    persistence: { listWorkflows } as unknown as HeadlessQueryDeps['persistence'],
    orchestrator: {} as unknown as HeadlessQueryDeps['orchestrator'],
    executionAgentRegistry: undefined,
    invokerConfig: {} as unknown as HeadlessQueryDeps['invokerConfig'],
    getUiPerfStats: () => ({}),
    resetUiPerfStats: () => {},
  };
}

describe('runReadOnlyHeadlessQueryToString', () => {
  it('captures rendered output instead of writing to process.stdout', async () => {
    const deps = makeQueryDeps(() => [{ id: 'wf-1' }, { id: 'wf-2' }]);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      const output = await runReadOnlyHeadlessQueryToString(
        ['query', 'workflows', '--output', 'label'],
        deps,
      );
      expect(output).toBe('wf-1\nwf-2\n');
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('captures review-gate output instead of writing to process.stdout', async () => {
    const deps = makeQueryDeps(() => []);
    deps.persistence = {
      ...deps.persistence,
      findReviewGateByPr: () => ({
        workflowId: 'wf-review',
        reviewId: 123,
        workflowStatus: 'running',
        workflowGeneration: 7,
        branch: 'stack/review',
      }),
    } as unknown as HeadlessQueryDeps['persistence'];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      const output = await runReadOnlyHeadlessQueryToString(
        ['query', 'review-gate', '123', '--output', 'label'],
        deps,
      );
      expect(output).toBe('wf-review\n');
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('maps the deprecated alias `list` to `query workflows`', async () => {
    const deps = makeQueryDeps(() => [{ id: 'wf-9' }]);
    const output = await runReadOnlyHeadlessQueryToString(['list', '--output', 'label'], deps);
    expect(output).toBe('wf-9\n');
  });

  it('rejects a command that is not a delegatable read-only query', async () => {
    const deps = makeQueryDeps(() => []);
    await expect(runReadOnlyHeadlessQueryToString(['watch', 'wf-1'], deps)).rejects.toThrow(
      /not a delegatable read-only query/,
    );
  });

  it('rejects `query ui-perf --reset` so delegation cannot clear owner stats', async () => {
    const resetUiPerfStats = vi.fn();
    const deps = { ...makeQueryDeps(() => []), resetUiPerfStats, getUiPerfStats: () => ({}) };
    await expect(
      runReadOnlyHeadlessQueryToString(['query', 'ui-perf', '--reset'], deps),
    ).rejects.toThrow(/read-only/);
    expect(resetUiPerfStats).not.toHaveBeenCalled();
  });

  it('still allows non-destructive `query ui-perf`', async () => {
    const resetUiPerfStats = vi.fn();
    const deps = { ...makeQueryDeps(() => []), resetUiPerfStats, getUiPerfStats: () => ({ mainDeltaToUi: 1 }) };
    await expect(runReadOnlyHeadlessQueryToString(['query', 'ui-perf'], deps)).resolves.toContain('mainDeltaToUi');
    expect(resetUiPerfStats).not.toHaveBeenCalled();
  });
});
