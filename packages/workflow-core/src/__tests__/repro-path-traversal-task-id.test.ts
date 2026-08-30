/**
 * Repro: Path-traversal task id accepted
 *
 * Symptom: Task id `../etc/passwd` stored as `wf-…/../etc/passwd`.
 * Task ids are concatenated into workflow-scoped paths without sanitizing.
 *
 * Root cause: parsePlan does not validate task ids for path-unsafe characters.
 * Task ids with `..`, `/`, or `\` can escape the intended directory scope.
 *
 * TODO(chaos-e-fix): These tests are marked it.fails because the current
 * implementation accepts task ids with path traversal characters.
 *
 * After the fix applies:
 * - parsePlan will reject task ids containing path-unsafe characters
 * - Tests will pass and should be changed from it.fails to it
 */

import { describe, it, expect } from 'vitest';
import { parsePlan, PlanParseError } from '../plan-parser.js';

describe('path-traversal task id validation', () => {
  it.fails('parsePlan should reject task id with ".." path traversal', () => {
    const yamlContent = `
name: Path traversal task
repoUrl: git@github.com:example/repo.git
tasks:
  - id: "../etc/passwd"
    description: Task with path traversal in id
    command: echo pwned
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it.fails('parsePlan should reject task id with forward slash', () => {
    const yamlContent = `
name: Forward slash task
repoUrl: git@github.com:example/repo.git
tasks:
  - id: "foo/bar"
    description: Task with forward slash in id
    command: echo test
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it.fails('parsePlan should reject task id with backslash', () => {
    const yamlContent = `
name: Backslash task
repoUrl: git@github.com:example/repo.git
tasks:
  - id: "foo\\bar"
    description: Task with backslash in id
    command: echo test
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it.fails('parsePlan should reject task id starting with dot', () => {
    const yamlContent = `
name: Dot prefix task
repoUrl: git@github.com:example/repo.git
tasks:
  - id: ".hidden-task"
    description: Task starting with dot
    command: echo test
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should accept task id with safe characters', () => {
    const yamlContent = `
name: Safe task
repoUrl: git@github.com:example/repo.git
tasks:
  - id: "safe-task_123"
    description: Task with safe characters
    command: echo test
`;

    const plan = parsePlan(yamlContent);
    expect(plan.tasks[0].id).toBe('safe-task_123');
  });

  it('parsePlan should accept task id with hyphen and underscore', () => {
    const yamlContent = `
name: Special chars task
repoUrl: git@github.com:example/repo.git
tasks:
  - id: "my-task_v2"
    description: Task with hyphen and underscore
    command: echo test
`;

    const plan = parsePlan(yamlContent);
    expect(plan.tasks[0].id).toBe('my-task_v2');
  });
});
