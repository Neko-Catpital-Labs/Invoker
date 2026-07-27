import { describe, expect, it, vi } from 'vitest';
import { normalizePersistedWorkflowBaseBranches } from '../workflow-base-branch-normalizer.js';

function makePersistence(workflows: Array<{ id: string; baseBranch?: string }>) {
  return {
    listWorkflows: vi.fn(() => workflows.map((workflow) => ({ ...workflow }))),
    updateWorkflow: vi.fn(),
  };
}

describe('normalizePersistedWorkflowBaseBranches', () => {
  it('fills missing refs and canonicalizes stored base refs', () => {
    const persistence = makePersistence([
      { id: 'wf-master', baseBranch: 'master' },
      { id: 'wf-origin-ref', baseBranch: 'refs/remotes/origin/master' },
      { id: 'wf-local-ref', baseBranch: 'refs/heads/release' },
      { id: 'wf-empty', baseBranch: '' },
      { id: 'wf-missing' },
    ]);
    const logger = { info: vi.fn() };

    const updated = normalizePersistedWorkflowBaseBranches(persistence, logger);

    expect(updated).toBe(4);
    expect(persistence.updateWorkflow).toHaveBeenCalledTimes(4);
    expect(persistence.updateWorkflow).toHaveBeenNthCalledWith(1, 'wf-origin-ref', { baseBranch: 'origin/master' });
    expect(persistence.updateWorkflow).toHaveBeenNthCalledWith(2, 'wf-local-ref', { baseBranch: 'release' });
    expect(persistence.updateWorkflow).toHaveBeenNthCalledWith(3, 'wf-empty', { baseBranch: 'master' });
    expect(persistence.updateWorkflow).toHaveBeenNthCalledWith(4, 'wf-missing', { baseBranch: 'master' });
    expect(logger.info).toHaveBeenCalledWith(
      '[init] normalized 4 workflow base branch refs to canonical form',
      { module: 'init', workflowCount: 4 },
    );
  });

  it('skips logging when every workflow already has a canonical base ref', () => {
    const persistence = makePersistence([
      { id: 'wf-master', baseBranch: 'master' },
      { id: 'wf-upstream', baseBranch: 'upstream/release' },
    ]);
    const logger = { info: vi.fn() };

    const updated = normalizePersistedWorkflowBaseBranches(persistence, logger);

    expect(updated).toBe(0);
    expect(persistence.updateWorkflow).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});
