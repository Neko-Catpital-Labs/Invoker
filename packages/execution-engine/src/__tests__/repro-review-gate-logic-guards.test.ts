import { describe, it, expect } from 'vitest';

import { isInvokerRepoUrl, parseMakePrStackPublishResult } from '../pr-authoring.js';
import { TaskRunner, type TaskRunnerConfig } from '../task-runner.js';
import type { TaskState } from '@invoker/workflow-core';

// Real-code repro guards for the review-gate "logic" bugs found while landing the
// Multi PR Review Gate stack, plus the sibling sites they also occur in.
//
//  #1757  isInvokerRepoUrl / parseMakePrStackPublishResult (pr-authoring)
//  #1811  mapReviewGateArtifactStatus lifecycle/review-decision collapse (task-runner)
//  #1865  reviewPollStillMatches stale-write guard (task-runner)
//  #1811 sibling: pollMergeGateTask scalar (legacy single-PR) path completing a closed PR

// ── helpers ──────────────────────────────────────────────

// Minimal collaborators: the probed methods below are pure / read only their
// arguments, so unrelated collaborator methods are never invoked.
function makeRunner(overrides: Partial<TaskRunnerConfig> = {}): TaskRunner {
  const baseOrchestrator = { getTask: () => undefined };
  const baseRegistry = { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] };
  return new TaskRunner({
    // test stubs: only the fields touched by the probed code paths are populated
    orchestrator: baseOrchestrator as unknown as TaskRunnerConfig['orchestrator'],
    persistence: {} as unknown as TaskRunnerConfig['persistence'],
    executorRegistry: baseRegistry as unknown as TaskRunnerConfig['executorRegistry'],
    cwd: '/tmp',
    ...overrides,
  });
}

interface ApprovalStatusInput {
  lifecycle?: 'open' | 'closed' | 'merged';
  rejected?: boolean;
  statusText?: string;
}

interface LineageTaskShape {
  status?: string;
  execution: { selectedAttemptId?: string; generation?: number; reviewGate?: unknown; reviewId?: string };
}

// Probe the private methods through a precise structural type (test-only boundary).
interface ReviewGateProbe {
  mapReviewGateArtifactStatus(status: ApprovalStatusInput): string;
  reviewPollStillMatches(before: LineageTaskShape, current: LineageTaskShape | undefined, providerId: string): boolean;
}
function probe(runner: TaskRunner): ReviewGateProbe {
  return runner as unknown as ReviewGateProbe;
}

// ── #1757: isInvokerRepoUrl ──────────────────────────────

describe('repro #1757: isInvokerRepoUrl accepts valid remote forms', () => {
  it('accepts a trailing-slash https remote (was rejected -> routed to non-Invoker path)', () => {
    expect(isInvokerRepoUrl('https://github.com/Neko-Catpital-Labs/Invoker/')).toBe(true);
  });

  it('still accepts the canonical https / ssh / .git forms', () => {
    expect(isInvokerRepoUrl('https://github.com/Neko-Catpital-Labs/Invoker')).toBe(true);
    expect(isInvokerRepoUrl('https://github.com/EdbertChan/Invoker.git')).toBe(true);
    expect(isInvokerRepoUrl('git@github.com:Neko-Catpital-Labs/Invoker.git')).toBe(true);
    expect(isInvokerRepoUrl('git@github.com:EdbertChan/Invoker.git/')).toBe(true);
  });

  it('rejects non-Invoker repos', () => {
    expect(isInvokerRepoUrl('https://github.com/other/repo')).toBe(false);
    expect(isInvokerRepoUrl(undefined)).toBe(false);
  });
});

// ── #1757: parseMakePrStackPublishResult ─────────────────

describe('repro #1757: parseMakePrStackPublishResult normalizes/validates identifiers', () => {
  const wrap = (artifacts: unknown[]): string => JSON.stringify({ artifacts });

  it('rejects whitespace-only id / url / dependency', () => {
    expect(() => parseMakePrStackPublishResult(wrap([{ id: '   ', url: 'u' }])))
      .toThrow(/id must be a non-empty string/);
    expect(() => parseMakePrStackPublishResult(wrap([{ id: 'a', url: '   ' }])))
      .toThrow(/url must be a non-empty string/);
    expect(() => parseMakePrStackPublishResult(wrap([
      { id: 'a', url: 'u' },
      { id: 'b', url: 'u2', dependsOn: ['  '] },
    ]))).toThrow(/dependsOn must contain non-empty artifact ids/);
  });

  it('trims padded id / url / dependency before persistence (no blank identifiers leak)', () => {
    const out = parseMakePrStackPublishResult(wrap([
      { id: '  a  ', url: '  https://x/1  ' },
      { id: '  b  ', url: 'https://x/2', dependsOn: ['  a  '] },
    ]));
    expect(out[0].id).toBe('a');
    expect(out[0].url).toBe('https://x/1');
    expect(out[1].id).toBe('b');
    expect(out[1].dependsOn).toEqual(['a']);
  });
  it('keeps GitHub provider ids aligned with the pull URL number', () => {
    const out = parseMakePrStackPublishResult(wrap([
      { id: 'a', url: 'https://github.com/owner/repo/pull/4261', providerId: 'github' },
      { id: 'b', url: 'https://github.com/owner/repo/pull/4279', providerId: 'github:4279', dependsOn: ['a'] },
      { id: 'c', url: 'https://github.com/owner/repo/pull/4284', providerId: 'PR_kwXYZ', dependsOn: ['b'] },
    ]));
    expect(out.map((artifact) => artifact.providerId)).toEqual(['4261', '4279', '4284']);
  });
  it('fills in the GitHub pull number when the agent omits providerId', () => {
    const out = parseMakePrStackPublishResult(wrap([
      { id: 'a', url: 'https://github.com/owner/repo/pull/4300' },
    ]));
    expect(out[0]?.providerId).toBe('4300');
  });
});

// ── #1811: mapReviewGateArtifactStatus ───────────────────

describe('repro #1811: mapReviewGateArtifactStatus collapses lifecycle + review decision', () => {
  it('maps a closed PR to "closed" even when changes were requested (lifecycle wins)', () => {
    const p = probe(makeRunner());
    // closed+merged is now unrepresentable; closed+rejected is the real overlap.
    expect(p.mapReviewGateArtifactStatus({ lifecycle: 'closed', rejected: true })).toBe('closed');
  });

  it('preserves the other mappings', () => {
    const p = probe(makeRunner());
    expect(p.mapReviewGateArtifactStatus({ lifecycle: 'merged', rejected: false })).toBe('approved');
    expect(p.mapReviewGateArtifactStatus({ lifecycle: 'open', rejected: true })).toBe('changes_requested');
    expect(p.mapReviewGateArtifactStatus({ lifecycle: 'closed', rejected: false })).toBe('closed');
    expect(p.mapReviewGateArtifactStatus({ lifecycle: 'open', rejected: false })).toBe('open');
  });
});

// ── #1865 / #1809: reviewPollStillMatches stale-write guard ──

describe('repro #1865: reviewPollStillMatches blocks writes after the task left approval', () => {
  const before: LineageTaskShape = {
    execution: { selectedAttemptId: 'att1', generation: 0, reviewGate: undefined, reviewId: 'pr#1' },
  };

  it('rejects a late poll when the task has since failed (matching lineage)', () => {
    const p = probe(makeRunner());
    const failed: LineageTaskShape = {
      status: 'failed',
      execution: { selectedAttemptId: 'att1', generation: 0, reviewGate: undefined, reviewId: 'pr#1' },
    };
    expect(p.reviewPollStillMatches(before, failed, 'pr#1')).toBe(false);
  });

  it('still allows a poll while the task is review_ready', () => {
    const p = probe(makeRunner());
    const reviewReady: LineageTaskShape = {
      status: 'review_ready',
      execution: { selectedAttemptId: 'att1', generation: 0, reviewGate: undefined, reviewId: 'pr#1' },
    };
    expect(p.reviewPollStillMatches(before, reviewReady, 'pr#1')).toBe(true);
  });
});

// ── #1811 sibling: scalar (legacy single-PR) poll path ───

describe('repro #1811 sibling: a closed PR must not complete a scalar merge gate', () => {
  it('does not complete the gate when the PR is closed', async () => {
    const task = {
      id: '__merge__wf-1',
      description: 'merge gate',
      status: 'review_ready',
      dependencies: [],
      createdAt: new Date(),
      config: { isMergeNode: true, workflowId: 'wf-1' },
      execution: { selectedAttemptId: 'att1', generation: 0, reviewId: 'pr#1' },
    } as unknown as TaskState; // test fixture: only fields read by the poll path are set
    const tasks = new Map<string, TaskState>([[task.id, task]]);

    let approveCalled = false;
    const updateCalls: Array<{ id: string; changes: unknown }> = [];

    const orchestrator = {
      getTask: (id: string) => tasks.get(id),
      approve: async () => { approveCalled = true; return []; },
    };
    const persistence = {
      updateTask: (id: string, changes: unknown) => { updateCalls.push({ id, changes }); return tasks.get(id); },
    };
    const mergeGateProvider = {
      checkApproval: async () => ({ lifecycle: 'closed', rejected: false, statusText: 'Closed' }),
    };

    const runner = makeRunner({
      orchestrator: orchestrator as unknown as TaskRunnerConfig['orchestrator'],
      persistence: persistence as unknown as TaskRunnerConfig['persistence'],
      mergeGateProvider: mergeGateProvider as unknown as TaskRunnerConfig['mergeGateProvider'],
    });

    await runner.checkPrApprovalNow(task.id);

    expect(approveCalled).toBe(false);
    // the closed status is persisted, not merely that "some" update fired
    const taskUpdate = updateCalls.find((c) => c.id === task.id);
    expect(taskUpdate).toBeDefined();
    expect((taskUpdate!.changes as { status?: string }).status).toBe('closed');
  });
});
