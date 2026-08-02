import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PlanDefinition } from '@invoker/workflow-core';
import { loadPlanSubmissionBundle } from '../plan-submission-loader.js';

type StoredWorkflow = { id: string; featureBranch?: string; baseBranch?: string };

function makeDeps() {
  const workflows: StoredWorkflow[] = [];
  const loadedPlans: PlanDefinition[] = [];

  return {
    loadedPlans,
    deps: {
      persistence: {
        listWorkflows: () => workflows.map((workflow) => ({ ...workflow })),
      },
      orchestrator: {
        loadPlan: (plan: PlanDefinition) => {
          loadedPlans.push(plan);
          workflows.push({
            id: `wf-${workflows.length + 1}`,
            featureBranch: plan.featureBranch,
            baseBranch: plan.baseBranch,
          });
        },
      },
    },
  };
}

describe('loadPlanSubmissionBundle', () => {
  beforeEach(() => {
    process.env.HOME = mkdtempSync(join(tmpdir(), 'invoker-plan-submission-loader-'));
  });

  it('pins ordinary single-plan submissions to the workflow base branch', async () => {
    const harness = makeDeps();

    await loadPlanSubmissionBundle(`
name: Single Plan
repoUrl: git@github.com:test/repo.git
baseBranch: release
tasks:
  - id: build
    description: Build it
    command: echo build
`, harness.deps);

    expect(harness.loadedPlans).toHaveLength(1);
    expect(harness.loadedPlans[0]?.baseBranch).toBe('master');
  });

  it('preserves explicit bases for submitted stack children', async () => {
    const harness = makeDeps();

    await loadPlanSubmissionBundle(`
name: Stacked Plan
repoUrl: git@github.com:test/repo.git
workflows:
  - name: Parent
    featureBranch: plan/parent
    tasks:
      - id: parent-task
        description: Parent task
        command: echo parent
  - name: Child
    baseBranch: plan/explicit-child-base
    featureBranch: plan/child
    tasks:
      - id: child-task
        description: Child task
        command: echo child
`, harness.deps);

    expect(harness.loadedPlans).toHaveLength(2);
    expect(harness.loadedPlans[0]?.baseBranch).toBe('master');
    expect(harness.loadedPlans[1]?.baseBranch).toBe('plan/parent');
  });
});
