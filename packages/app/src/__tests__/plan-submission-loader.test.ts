import { describe, expect, it, vi } from 'vitest';
import type { PlanDefinition } from '@invoker/workflow-core';
import { AgentRegistry, type ExecutionAgent } from '@invoker/execution-engine';

vi.mock('../plan-backup.js', () => ({
  backupPlan: vi.fn(() => '/tmp/invoker-plan-backup.yaml'),
}));

import { loadPlanSubmissionBundle } from '../plan-submission-loader.js';

function makeFixedModelRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  const codexAgent: ExecutionAgent = {
    name: 'codex',
    stdinMode: 'ignore',
    supportedModels: [{ id: 'gpt-5.5', label: 'GPT-5.5' }],
    supportedModelsProvenance: 'built-in',
    buildCommand: () => ({ cmd: 'codex', args: [] }),
    buildResumeArgs: () => ({ cmd: 'codex', args: [] }),
  };
  registry.registerExecution(codexAgent);
  return registry;
}

function makeDeps() {
  const workflows: Array<{ id: string; featureBranch?: string; staged?: boolean }> = [];
  const loadedPlans: PlanDefinition[] = [];
  return {
    loadedPlans,
    deps: {
      persistence: {
        listWorkflows: vi.fn(() => workflows.map((workflow) => ({ ...workflow }))),
        loadWorkflow: vi.fn((workflowId: string) => {
          const workflow = workflows.find((candidate) => candidate.id === workflowId);
          return workflow ? { ...workflow } : undefined;
        }),
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
          return `wf-${loadedPlans.length}`;
        }),
      },
      allowGraphMutation: true,
      executionAgentRegistry: makeFixedModelRegistry(),
    },
  };
}

describe('loadPlanSubmissionBundle', () => {
  it('resolves only dot to the bound repository while preserving an explicit repository URL', async () => {
    const { deps, loadedPlans } = makeDeps();

    await loadPlanSubmissionBundle(`
name: Bound Repository Stack
repoUrl: .
workflows:
  - name: Bound Repository Workflow
    featureBranch: plan/bound-repository
    tasks:
      - id: bound
        description: Use the planning session repository
  - name: Explicit Repository Workflow
    repoUrl: git@github.com:test/explicit-repo.git
    featureBranch: plan/explicit-repository
    tasks:
      - id: explicit
        description: Keep the explicit repository
`, deps, {
      repositoryBinding: {
        repoUrl: '/home/demo/demo-repo',
        baseBranch: 'main',
      },
    });

    expect(loadedPlans).toHaveLength(2);
    expect(loadedPlans[0]?.repoUrl).toBe('/home/demo/demo-repo');
    expect(loadedPlans[1]?.repoUrl).toBe('git@github.com:test/explicit-repo.git');
  });

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

  it('defaults worker-submitted task priority below human-submitted default', async () => {
    const { deps, loadedPlans } = makeDeps();
    const plan = `
name: Worker Plan
repoUrl: git@github.com:test/repo.git
tasks:
  - id: build
    description: Build it
`;

    await loadPlanSubmissionBundle(plan, deps, { submittedBy: 'worker' });

    expect(loadedPlans[0]?.tasks[0]?.priority).toBeLessThan(0);
  });

  it('leaves task priority unset for a human-submitted plan', async () => {
    const { deps, loadedPlans } = makeDeps();
    const plan = `
name: Human Plan
repoUrl: git@github.com:test/repo.git
tasks:
  - id: build
    description: Build it
`;

    await loadPlanSubmissionBundle(plan, deps);

    expect(loadedPlans[0]?.tasks[0]?.priority).toBeUndefined();
  });

  it('does not override an explicit task priority on a worker-submitted plan', async () => {
    const { deps, loadedPlans } = makeDeps();
    const plan = `
name: Worker Plan With Explicit Priority
repoUrl: git@github.com:test/repo.git
tasks:
  - id: build
    description: Build it
    priority: 5
`;

    await loadPlanSubmissionBundle(plan, deps, { submittedBy: 'worker' });

    expect(loadedPlans[0]?.tasks[0]?.priority).toBe(5);
  });

  it('rejects a plan whose task names an unrunnable agent/model pairing before loading any workflow', async () => {
    const { deps, loadedPlans } = makeDeps();
    const plan = `
name: Bad Model Plan
repoUrl: git@github.com:test/repo.git
tasks:
  - id: build
    description: Build it
    executionAgent: codex
    executionModel: gpt-5.6-luna
`;

    await expect(loadPlanSubmissionBundle(plan, deps)).rejects.toThrow(/build/);

    expect(deps.orchestrator.loadPlan).not.toHaveBeenCalled();
    expect(loadedPlans).toHaveLength(0);
    expect(deps.persistence.listWorkflows()).toHaveLength(0);
  });

  it('rejects the whole bundle when only the second workflow has a bad agent/model pairing', async () => {
    const { deps, loadedPlans } = makeDeps();
    const plan = `
name: Mixed Stack
repoUrl: git@github.com:test/repo.git
workflows:
  - name: Good Step
    featureBranch: plan/good-step
    tasks:
      - id: good
        description: Fine
  - name: Bad Step
    featureBranch: plan/bad-step
    tasks:
      - id: bad
        description: Not fine
        executionAgent: codex
        executionModel: gpt-5.6-luna
`;

    await expect(loadPlanSubmissionBundle(plan, deps)).rejects.toThrow(/bad/);

    expect(deps.orchestrator.loadPlan).not.toHaveBeenCalled();
    expect(loadedPlans).toHaveLength(0);
  });
});
