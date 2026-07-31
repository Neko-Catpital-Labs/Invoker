import { describe, expect, it, vi } from 'vitest';
import { normalizePersistedWorkflowBaseBranches } from '../workflow-base-branch-normalizer.js';

function makePersistence(workflows: Array<{ id: string; baseBranch?: string }>) {
  return {
    listWorkflows: vi.fn(() => workflows.map((workflow) => ({ ...workflow }))),
    updateWorkflow: vi.fn(),
  };
}

describe('normalizePersistedWorkflowBaseBranches', () => {
  it('defaults missing workflow base branches without rewriting explicit stack bases', () => {
    const persistence = makePersistence([
      { id: 'wf-master', baseBranch: 'master' },
      { id: 'wf-main', baseBranch: 'main' },
      { id: 'wf-stack', baseBranch: 'plan/upstream-step' },
      { id: 'wf-empty', baseBranch: '' },
      { id: 'wf-missing' },
    ]);
    const logger = { info: vi.fn() };

    const updated = normalizePersistedWorkflowBaseBranches(persistence, logger);

    expect(updated).toBe(2);
    expect(persistence.updateWorkflow).toHaveBeenCalledTimes(2);
    expect(persistence.updateWorkflow).toHaveBeenNthCalledWith(1, 'wf-empty', { baseBranch: 'master' });
    expect(persistence.updateWorkflow).toHaveBeenNthCalledWith(2, 'wf-missing', { baseBranch: 'master' });
    expect(logger.info).toHaveBeenCalledWith(
      '[init] defaulted 2 missing workflow base branches to master',
      { module: 'init', workflowCount: 2, baseBranch: 'master' },
    );
  });

  it('skips logging when every workflow already targets master', () => {
    const persistence = makePersistence([{ id: 'wf-master', baseBranch: 'master' }]);
    const logger = { info: vi.fn() };

    const updated = normalizePersistedWorkflowBaseBranches(persistence, logger);

    expect(updated).toBe(0);
    expect(persistence.updateWorkflow).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});
