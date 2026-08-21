import { describe, expect, it, vi } from 'vitest';
import type { PlanDefinition } from '@invoker/workflow-core';

vi.mock('../plan-backup.js', () => ({
  backupPlan: vi.fn(() => '/tmp/invoker-plan-backup.yaml'),
}));

import { loadPlanSubmissionBundle } from '../plan-submission-loader.js';

function makeDeps() {
  const workflows: Array<{ id: string; featureBranch?: string; staged?: boolean }> = [];
  const loadedPlans: PlanDefinition[] = [];
  return {
    loadedPlans,
    deps: {
      persistence: {
        listWorkflows: vi.fn(() => workflows.map((workflow) => ({ ...workflow }))),
        updateWorkflow: vi.fn((workflowId: string, changes: { staged: boolean }) => {
          const workflow = workflows.find((candidate) => candidate.id === workflowId);
          if (workflow) workflow.staged = changes.staged;
        }),
      },
      orchestrator: {
        loadPlan: vi.fn((plan: PlanDefinition, _opts: { allowGraphMutation?: boolean; staged?: boolean }) => {
          loadedPlans.push(plan);
          workflows.push({
            id: `wf-${loadedPlans.length}`,
            featureBranch: plan.featureBranch,
          });
        }),
      },
      allowGraphMutation: true,
    },
  };
}

describe('loadPlanSubmissionBundle', () => {
  it('passes staged state only when requested by the planning preview path', async () => {
    const { deps } = makeDeps();
    const plan = `
name: Preview
repoUrl: git@github.com:test/repo.git
tasks:
  - id: build
    description: Build it
`;

    await loadPlanSubmissionBundle(plan, deps, { staged: true });

    expect(deps.orchestrator.loadPlan).toHaveBeenCalledWith(
      expect.anything(),
      { allowGraphMutation: true, staged: true },
    );
    expect(deps.persistence.updateWorkflow).toHaveBeenCalledWith('wf-1', { staged: true });
    expect(deps.persistence.listWorkflows()[0]?.staged).toBe(true);
  });

  it('pins a single submitted workflow base branch to master', async () => {
    const { deps, loadedPlans } = makeDeps();

    await loadPlanSubmissionBundle(`
name: Single Review Workflow
repoUrl: git@github.com:test/repo.git
baseBranch: release
featureBranch: plan/single-review-workflow
tasks:
  - id: build
    description: Build it
`, deps);

    expect(loadedPlans).toHaveLength(1);
    expect(loadedPlans[0]?.baseBranch).toBe('master');
  });

  it('preserves stack bases while linking downstream workflows to the upstream feature branch', async () => {
    const { deps, loadedPlans } = makeDeps();

    await loadPlanSubmissionBundle(`
name: Stack Review
repoUrl: git@github.com:test/repo.git
workflows:
  - name: Upstream Step
    baseBranch: release
    featureBranch: plan/upstream-step
    tasks:
      - id: build-upstream
        description: Build upstream
  - name: Downstream Step
    featureBranch: plan/downstream-step
    tasks:
      - id: build-downstream
        description: Build downstream
`, deps);

    expect(loadedPlans).toHaveLength(2);
    expect(loadedPlans[0]?.baseBranch).toBe('release');
    expect(loadedPlans[1]?.baseBranch).toBe('plan/upstream-step');
    expect(loadedPlans[1]?.externalDependencies).toContainEqual({
      workflowId: 'wf-1',
      taskId: '__merge__',
      requiredStatus: 'completed',
      gatePolicy: 'review_ready',
    });
  });
});
