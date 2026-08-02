import { describe, expect, it, vi } from 'vitest';
import type { PlanDefinition } from '@invoker/workflow-core';

vi.mock('../plan-backup.js', () => ({
  backupPlan: vi.fn(() => '/tmp/invoker-plan-backup.yaml'),
}));

import { loadPlanSubmissionBundle } from '../plan-submission-loader.js';

function makeDeps() {
  const workflows: Array<{ id: string; featureBranch?: string }> = [];
  const loadedPlans: PlanDefinition[] = [];
  return {
    loadedPlans,
    deps: {
      persistence: {
        listWorkflows: vi.fn(() => workflows.map((workflow) => ({ ...workflow }))),
      },
      orchestrator: {
        loadPlan: vi.fn((plan: PlanDefinition, _opts: { allowGraphMutation?: boolean }) => {
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
