/**
 * Repro: mergeMode: no_op skips onFinish: merge / pull_request
 *
 * Symptom: Plan with mergeMode: no_op and onFinish: pull_request/merge
 * completes the workflow without merging or creating a PR.
 * The master branch stays at the initial commit.
 *
 * Root cause: parsePlan does not validate that mergeMode: no_op
 * requires onFinish: none. The combination is contradictory.
 *
 * Invariant: mergeMode: no_op must use onFinish: none, or load must
 * reject the combination to prevent silent skipping of merge/PR.
 *
 * TODO(chaos-m-fix): These tests are marked it.fails because the current
 * implementation accepts the contradictory combination.
 *
 * After the fix applies:
 * - parsePlan will reject mergeMode: no_op with onFinish: merge/pull_request
 * - Tests will pass and should be changed from it.fails to it
 */

import { describe, it, expect } from 'vitest';
import { parsePlan, PlanParseError } from '../plan-parser.js';

describe('mergeMode no_op + onFinish validation', () => {
  it.fails('parsePlan should reject mergeMode: no_op with onFinish: merge', () => {
    const yamlContent = `
name: No-op merge mismatch
repoUrl: git@github.com:example/repo.git
mergeMode: no_op
onFinish: merge
tasks:
  - id: task1
    description: Test task
    command: echo test
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it.fails('parsePlan should reject mergeMode: no_op with onFinish: pull_request', () => {
    const yamlContent = `
name: No-op PR mismatch
repoUrl: git@github.com:example/repo.git
mergeMode: no_op
onFinish: pull_request
tasks:
  - id: task1
    description: Test task
    command: echo test
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should accept mergeMode: no_op with onFinish: none', () => {
    const yamlContent = `
name: Valid no-op
repoUrl: git@github.com:example/repo.git
mergeMode: no_op
onFinish: none
tasks:
  - id: task1
    description: Test task
    command: echo test
`;

    const plan = parsePlan(yamlContent);
    expect(plan.mergeMode).toBe('no_op');
    expect(plan.onFinish).toBe('none');
  });

  it('parsePlan should accept non-no_op mergeMode with onFinish: pull_request', () => {
    const yamlContent = `
name: Valid manual merge
repoUrl: git@github.com:example/repo.git
mergeMode: manual
onFinish: pull_request
tasks:
  - id: task1
    description: Test task
    command: echo test
`;

    const plan = parsePlan(yamlContent);
    expect(plan.mergeMode).toBe('manual');
    expect(plan.onFinish).toBe('pull_request');
  });
});
