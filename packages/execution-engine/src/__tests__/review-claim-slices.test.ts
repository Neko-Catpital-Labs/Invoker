import { describe, expect, it, vi } from 'vitest';

import { reviewClaimSlices } from '../pr-authoring.js';
import { publishReviewArtifactsForMerge, type MergeRunnerHost } from '../merge-runner.js';

const behaviorPrompt = {
  description: 'Review claim:\n- A shared test base isolates judge state.\nReview lane:\n- behavior\n',
};
const policyPrompt = {
  description: 'Review claim: The coverage gate fails hooks that skip the base.\nReview lane: policy\n',
};
const verifyCommand = {
  description: 'Review claim:\n- The judge suites pass.\nReview lane:\n- proof\n',
  command: 'pnpm test',
};
const reproPrompt = {
  description: 'Review claim:\n- A repro shows the bug.\nReview lane:\n- proof\n',
};

describe('reviewClaimSlices', () => {
  it('lists each distinct claim carried by prompt tasks', () => {
    expect(reviewClaimSlices([behaviorPrompt, policyPrompt, verifyCommand])).toEqual([
      'A shared test base isolates judge state.',
      'The coverage gate fails hooks that skip the base.',
    ]);
  });

  it('ignores command tasks and prompt tasks in the proof or cleanup lanes', () => {
    expect(reviewClaimSlices([behaviorPrompt, verifyCommand, reproPrompt])).toEqual([
      'A shared test base isolates judge state.',
    ]);
  });

  it('counts the same claim on two tasks once', () => {
    expect(reviewClaimSlices([behaviorPrompt, { ...behaviorPrompt }])).toHaveLength(1);
  });

  it('returns nothing for tasks without a review claim', () => {
    expect(reviewClaimSlices([{ description: 'Goal: tidy up.' }])).toEqual([]);
  });
});

describe('single-PR publication of a workflow with more than one review claim', () => {
  it('refuses before authoring or creating the PR', async () => {
    const createReview = vi.fn();
    const task = (id: string, description: string) => ({
      id,
      description,
      status: 'completed',
      config: { workflowId: 'wf-bundled' },
      execution: {},
    });
    const host = {
      orchestrator: {
        getAllTasks: () => [
          task('wf-bundled/implement-base', behaviorPrompt.description),
          task('wf-bundled/implement-gate', policyPrompt.description),
        ],
      },
      persistence: {
        loadWorkflow: () => ({ id: 'wf-bundled', name: 'Bundled', repoUrl: 'https://github.com/example/other.git' }),
        updateTask: vi.fn(),
      },
      mergeGateProvider: { name: 'github', createReview },
      gitDiffStat: vi.fn(async () => ''),
    } as unknown as MergeRunnerHost;

    await expect(
      publishReviewArtifactsForMerge(host, {
        workflowId: 'wf-bundled',
        mergeNodeTaskId: '__merge__wf-bundled',
        workflowName: 'Bundled',
        baseBranch: 'master',
        featureBranch: 'plan/bundled',
        workflowSummary: '',
        cwd: '/tmp',
        expectedGeneration: 0,
        repoUrl: 'https://github.com/example/other.git',
      }),
    ).rejects.toThrow(/carries 2 review claims/);
    expect(createReview).not.toHaveBeenCalled();
  });
});
