import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PUBLISH_MODE_DECLARATION_PATH,
  parsePublishMode,
  readPublishModeDeclaration,
  resolvePublishMode,
  type PublishMode,
} from '../pr-authoring.js';
import { publishReviewArtifactsForMerge, type MergeRunnerHost } from '../merge-runner.js';

const INVOKER_REPO = 'https://github.com/Neko-Catpital-Labs/Invoker.git';
const OTHER_REPO = 'https://github.com/example/catstack.git';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function worktree(declaration?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'publish-mode-'));
  directories.push(dir);
  if (declaration !== undefined) {
    mkdirSync(join(dir, '.invoker'), { recursive: true });
    writeFileSync(join(dir, PUBLISH_MODE_DECLARATION_PATH), declaration);
  }
  return dir;
}

const firstClaim = {
  description: 'Review claim:\n- A repository can declare stack publishing.\nReview lane:\n- behavior\n',
};
const secondClaim = {
  description: 'Review claim:\n- Submit honors the declaration.\nReview lane:\n- behavior\n',
};

function stackPublishHost(args: { repoUrl: string; claims: Array<{ description: string }> }) {
  const createReview = vi.fn();
  const publishReviewStackWithMakePrSkill = vi.fn(async () => ({
    artifacts: args.claims.map((_, index) => ({
      id: `artifact-${index}`,
      url: `https://github.com/example/catstack/pull/${index + 1}`,
      providerId: `${index + 1}`,
    })),
    sessionId: 'session-1',
    agentName: 'claude',
  }));
  const host = {
    orchestrator: {
      getAllTasks: () => args.claims.map((claim, index) => ({
        id: `wf-declared/task-${index}`,
        description: claim.description,
        status: 'completed',
        config: { workflowId: 'wf-declared' },
        execution: {},
      })),
    },
    persistence: {
      loadWorkflow: () => ({ id: 'wf-declared', name: 'Declared', repoUrl: args.repoUrl }),
      updateTask: vi.fn(),
    },
    mergeGateProvider: { name: 'github', createReview },
    gitDiffStat: vi.fn(async () => ''),
    publishReviewStackWithMakePrSkill,
  } as unknown as MergeRunnerHost;
  return { host, createReview, publishReviewStackWithMakePrSkill };
}

function publish(host: MergeRunnerHost, args: { repoUrl: string; cwd: string }) {
  return publishReviewArtifactsForMerge(host, {
    workflowId: 'wf-declared',
    mergeNodeTaskId: '__merge__wf-declared',
    workflowName: 'Declared',
    baseBranch: 'master',
    featureBranch: 'plan/declared',
    workflowSummary: '',
    cwd: args.cwd,
    expectedGeneration: 0,
    repoUrl: args.repoUrl,
  });
}

describe('resolvePublishMode', () => {
  it('stacks for the Invoker repository when no declaration is present', () => {
    expect(resolvePublishMode({ repoUrl: INVOKER_REPO })).toBe('stack');
  });

  it('opens one pull request for every other repository when no declaration is present', () => {
    expect(resolvePublishMode({ repoUrl: OTHER_REPO })).toBe('single');
    expect(resolvePublishMode({})).toBe('single');
  });

  it('lets a declaration override the repository name in both directions', () => {
    expect(resolvePublishMode({ repoUrl: OTHER_REPO, declaredMode: 'stack' })).toBe('stack');
    expect(resolvePublishMode({ repoUrl: INVOKER_REPO, declaredMode: 'single' })).toBe('single');
  });
});

describe('parsePublishMode', () => {
  it('accepts exactly stack and single', () => {
    expect(parsePublishMode('stack', 'field')).toBe('stack');
    expect(parsePublishMode(' single\n', 'field')).toBe('single');
  });

  it('reads an absent or empty value as no declaration', () => {
    expect(parsePublishMode(undefined, 'field')).toBeUndefined();
    expect(parsePublishMode('   ', 'field')).toBeUndefined();
  });

  it('refuses any other value instead of falling back', () => {
    expect(() => parsePublishMode('stacked', 'field')).toThrow(/must be "stack" or "single", got "stacked"/);
    expect(() => parsePublishMode(7, 'field')).toThrow(/must be "stack" or "single"/);
  });
});

describe('readPublishModeDeclaration', () => {
  it('returns nothing when the repository commits no declaration', () => {
    expect(readPublishModeDeclaration(worktree())).toBeUndefined();
    expect(readPublishModeDeclaration(undefined)).toBeUndefined();
  });

  it('reads a committed declaration', () => {
    expect(readPublishModeDeclaration(worktree('stack\n'))).toBe('stack');
    expect(readPublishModeDeclaration(worktree('single'))).toBe('single');
  });

  it('refuses a declaration file it cannot interpret', () => {
    expect(() => readPublishModeDeclaration(worktree('stak\n'))).toThrow(/must be "stack" or "single"/);
  });
});

describe('publishReviewArtifactsForMerge honors the declaration', () => {
  it('publishes a stack for a non-Invoker repository that declares stack', async () => {
    const { host, publishReviewStackWithMakePrSkill, createReview } = stackPublishHost({
      repoUrl: OTHER_REPO,
      claims: [firstClaim, secondClaim],
    });

    const published = await publish(host, { repoUrl: OTHER_REPO, cwd: worktree('stack\n') });

    expect(publishReviewStackWithMakePrSkill).toHaveBeenCalledTimes(1);
    expect(createReview).not.toHaveBeenCalled();
    expect(published.reviewGate.artifacts).toHaveLength(2);
  });

  it('stops a two-claim workflow in a repository that declares single', async () => {
    const { host, publishReviewStackWithMakePrSkill } = stackPublishHost({
      repoUrl: INVOKER_REPO,
      claims: [firstClaim, secondClaim],
    });

    await expect(
      publish(host, { repoUrl: INVOKER_REPO, cwd: worktree('single\n') }),
    ).rejects.toThrow(/carries 2 review claims/);
    expect(publishReviewStackWithMakePrSkill).not.toHaveBeenCalled();
  });

  it('keeps stacking in the Invoker repository when no declaration is present', async () => {
    const { host, publishReviewStackWithMakePrSkill } = stackPublishHost({
      repoUrl: INVOKER_REPO,
      claims: [firstClaim, secondClaim],
    });

    await publish(host, { repoUrl: INVOKER_REPO, cwd: worktree() });

    expect(publishReviewStackWithMakePrSkill).toHaveBeenCalledTimes(1);
  });

  it('stops a two-claim workflow in a repository with no declaration', async () => {
    const { host, publishReviewStackWithMakePrSkill } = stackPublishHost({
      repoUrl: OTHER_REPO,
      claims: [firstClaim, secondClaim],
    });

    await expect(
      publish(host, { repoUrl: OTHER_REPO, cwd: worktree() }),
    ).rejects.toThrow(/carries 2 review claims/);
    expect(publishReviewStackWithMakePrSkill).not.toHaveBeenCalled();
  });
});

describe('the declaration is one resolver shared with submit', () => {
  it('agrees with the submit-time decision for every declaration state', () => {
    const states: Array<{ declaration?: string; repoUrl: string; expected: PublishMode }> = [
      { repoUrl: OTHER_REPO, expected: 'single' },
      { repoUrl: INVOKER_REPO, expected: 'stack' },
      { declaration: 'stack', repoUrl: OTHER_REPO, expected: 'stack' },
      { declaration: 'single', repoUrl: INVOKER_REPO, expected: 'single' },
    ];
    for (const state of states) {
      const fromFile = readPublishModeDeclaration(worktree(state.declaration));
      const fromPlanField = parsePublishMode(state.declaration, 'Plan field "publishMode"');
      expect(resolvePublishMode({ repoUrl: state.repoUrl, declaredMode: fromFile })).toBe(state.expected);
      expect(resolvePublishMode({ repoUrl: state.repoUrl, declaredMode: fromPlanField })).toBe(state.expected);
    }
  });
});
