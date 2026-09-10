import { describe, expect, it } from 'vitest';

import { parseRunChainArgs, wireStackedPlan } from '../index.js';

const STACKED_PLAN = [
  'name: "Example (2) second slice"',
  'onFinish: pull_request',
  'mergeMode: external_review',
  'baseBranch: master',
  'repoUrl: https://github.com/acme/web.git',
  '',
  'externalDependencies:',
  '  - workflowId: "__UPSTREAM_WORKFLOW_ID__"',
  '    requiredStatus: completed',
  '',
  'tasks: []',
].join('\n');

describe('parseRunChainArgs', () => {
  it('defaults the gate policy to review_ready', () => {
    expect(parseRunChainArgs(['a.yaml']).gatePolicy).toBe('review_ready');
  });

  it('accepts both documented gate policies', () => {
    expect(parseRunChainArgs(['--gate-policy', 'completed', 'a.yaml']).gatePolicy).toBe('completed');
    expect(parseRunChainArgs(['--gate-policy', 'review_ready', 'a.yaml']).gatePolicy).toBe('review_ready');
  });

  it('rejects an unknown gate policy rather than falling back to a default', () => {
    expect(() => parseRunChainArgs(['--gate-policy', 'whenever', 'a.yaml']))
      .toThrow(/Invalid --gate-policy value: whenever/);
  });

  it('rejects an unknown option', () => {
    expect(() => parseRunChainArgs(['--merge-now', 'a.yaml'])).toThrow(/Unknown run-chain option: --merge-now/);
  });

  it('requires at least one plan path', () => {
    expect(() => parseRunChainArgs([])).toThrow(/Missing plan file/);
    expect(() => parseRunChainArgs(['--gate-policy', 'completed'])).toThrow(/Missing plan file/);
  });

  it('keeps plan order and reads --onto-workflow', () => {
    const parsed = parseRunChainArgs(['--onto-workflow', 'wf-1', 'a.yaml', 'b.yaml', 'c.yaml']);
    expect(parsed.ontoWorkflow).toBe('wf-1');
    expect(parsed.planPaths).toEqual(['a.yaml', 'b.yaml', 'c.yaml']);
  });

  it('rejects --onto-workflow with no value', () => {
    expect(() => parseRunChainArgs(['--onto-workflow'])).toThrow(/Missing value for --onto-workflow/);
  });
});

describe('wireStackedPlan', () => {
  it('rewrites baseBranch to the upstream feature branch', () => {
    const wired = wireStackedPlan(STACKED_PLAN, 'b.yaml', 'wf-7', 'plan/first-slice', 'review_ready');
    expect(wired).toContain('baseBranch: plan/first-slice');
    expect(wired).not.toContain('baseBranch: master');
  });

  it('replaces the upstream placeholder and injects the merge gate', () => {
    const wired = wireStackedPlan(STACKED_PLAN, 'b.yaml', 'wf-7', 'plan/first-slice', 'review_ready');
    expect(wired).not.toContain('__UPSTREAM_WORKFLOW_ID__');
    expect(wired).toContain('- workflowId: "wf-7"');
    expect(wired).toContain('taskId: "__merge__"');
    expect(wired).toContain('gatePolicy: review_ready');
    expect(wired).toContain('requiredStatus: completed');
  });

  it('injects the requested gate policy rather than a fixed one', () => {
    const wired = wireStackedPlan(STACKED_PLAN, 'b.yaml', 'wf-7', 'plan/first-slice', 'completed');
    expect(wired).toContain('gatePolicy: completed');
  });

  it('refuses a plan that carries no upstream placeholder', () => {
    const unstacked = STACKED_PLAN.replace('"__UPSTREAM_WORKFLOW_ID__"', '"wf-already-set"');
    expect(() => wireStackedPlan(unstacked, 'b.yaml', 'wf-7', 'plan/first-slice', 'review_ready'))
      .toThrow(/does not contain __UPSTREAM_WORKFLOW_ID__/);
  });
});
