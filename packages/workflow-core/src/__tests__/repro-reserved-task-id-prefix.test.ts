/**
 * Repro: __merge__ task id impersonation
 *
 * Symptom: Plan task id `__merge__w3fake` bypassed ${workflowId}/ scoping.
 * Fake node ran as a normal task (completed), created unscoped branch
 * `experiment/__merge__w3fake/…`, AND a real gate `__merge__${workflowId}`
 * was still created.
 *
 * Root cause: parsePlan does not validate that task ids don't use reserved
 * prefixes like `__merge__`. The scopePlanTaskId function treats ids starting
 * with `__merge__` as already-scoped merge nodes.
 *
 * Invariant: `__merge__*` is reserved; plan-local ids must always be scoped;
 * a user task must not become the merge node or an unscoped experiment branch.
 *
 * Fix applied:
 * - parsePlan now validates that task ids don't start with reserved prefixes
 * - Task ids starting with `__merge__` are rejected with a clear error
 */

import { describe, it, expect } from 'vitest';
import { parsePlan, PlanParseError } from '../plan-parser.js';

describe('reserved task id prefix validation', () => {
  it('parsePlan should reject task id starting with __merge__', () => {
    const yamlContent = `
name: Merge impersonation
repoUrl: git@github.com:example/repo.git
tasks:
  - id: "__merge__w3fake"
    description: Task impersonating merge node
    command: echo pwned
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should reject task id exactly matching __merge__', () => {
    const yamlContent = `
name: Exact merge impersonation
repoUrl: git@github.com:example/repo.git
tasks:
  - id: "__merge__"
    description: Task with exact merge node id
    command: echo pwned
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should reject task id with __merge__ prefix and workflow-like suffix', () => {
    const yamlContent = `
name: Workflow merge impersonation
repoUrl: git@github.com:example/repo.git
tasks:
  - id: "__merge__wf-1234"
    description: Task impersonating another workflow merge node
    command: echo pwned
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should accept task id with merge in the name but not as prefix', () => {
    const yamlContent = `
name: Safe merge reference
repoUrl: git@github.com:example/repo.git
tasks:
  - id: "run-merge-tests"
    description: Task with merge in name
    command: echo test
`;

    const plan = parsePlan(yamlContent);
    expect(plan.tasks[0].id).toBe('run-merge-tests');
  });

  it('parsePlan should accept task id with underscore prefix but not reserved', () => {
    const yamlContent = `
name: Underscore prefix
repoUrl: git@github.com:example/repo.git
tasks:
  - id: "_private_task"
    description: Task with underscore prefix
    command: echo test
`;

    const plan = parsePlan(yamlContent);
    expect(plan.tasks[0].id).toBe('_private_task');
  });

  it('parsePlan should reject task id attempting cross-workflow gate steal', () => {
    const yamlContent = `
name: Cross-workflow gate steal
repoUrl: git@github.com:example/repo.git
tasks:
  - id: "__merge__wf-1788115593379-67"
    description: Task stealing another workflow gate
    command: echo stolen-gate
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });
});
