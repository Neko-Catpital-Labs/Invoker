import { describe, expect, it, vi } from 'vitest';
import { normalizePersistedWorkflowBaseBranches } from '../workflow-base-branch-normalizer.js';

function makePersistence(workflows: Array<{ id: string; baseBranch?: string }>) {
  return {
    listWorkflows: vi.fn(() => workflows.map((workflow) => ({ ...workflow }))),
    updateWorkflow: vi.fn(),
  };
}

describe('normalizePersistedWorkflowBaseBranches', () => {
  it('rewrites every non-master workflow base branch to master', () => {
    const persistence = makePersistence([
      { id: 'wf-master', baseBranch: 'master' },
      { id: 'wf-main', baseBranch: 'main' },
      { id: 'wf-empty', baseBranch: '' },
      { id: 'wf-missing' },
    ]);
    const logger = { info: vi.fn() };

    const updated = normalizePersistedWorkflowBaseBranches(persistence, logger);

    expect(updated).toBe(3);
    expect(persistence.updateWorkflow).toHaveBeenCalledTimes(3);
    expect(persistence.updateWorkflow).toHaveBeenNthCalledWith(1, 'wf-main', { baseBranch: 'master' });
    expect(persistence.updateWorkflow).toHaveBeenNthCalledWith(2, 'wf-empty', { baseBranch: 'master' });
    expect(persistence.updateWorkflow).toHaveBeenNthCalledWith(3, 'wf-missing', { baseBranch: 'master' });
    expect(logger.info).toHaveBeenCalledWith(
      '[init] normalized 3 workflow base branches to master',
      { module: 'init', workflowCount: 3, baseBranch: 'master' },
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
