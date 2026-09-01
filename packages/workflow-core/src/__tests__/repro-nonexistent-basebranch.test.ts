/**
 * Repro: Nonexistent baseBranch accepted
 *
 * Symptom: `baseBranch: definitely-does-not-exist-w3` loads without error.
 * Leaf task completes, but merge node fails with "Branch not found on remote".
 * Work is done before the error surfaces.
 *
 * Root cause: baseBranch is not validated as a valid git ref at parse time.
 * Invalid or nonexistent refs are accepted, causing failures only at runtime.
 *
 * Invariant: baseBranch must be a valid git ref format at parse time.
 * Missing refs should fail closed at load, not after leaf work is done.
 *
 * Fix applied:
 * - parsePlan now validates baseBranch with isValidGitRef()
 * - Invalid baseBranch values are rejected with a clear error message
 */

import { describe, it, expect } from 'vitest';
import { parsePlan, PlanParseError } from '../plan-parser.js';

describe('baseBranch validation', () => {
  it('parsePlan should reject baseBranch with path traversal', () => {
    const yamlContent = `
name: Base escape test
repoUrl: git@github.com:example/repo.git
baseBranch: "../escape-branch"
tasks:
  - id: task1
    description: Test task
    command: echo test
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should reject baseBranch with empty string', () => {
    const yamlContent = `
name: Empty base test
repoUrl: git@github.com:example/repo.git
baseBranch: ""
tasks:
  - id: task1
    description: Test task
    command: echo test
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should reject baseBranch with trailing slash', () => {
    const yamlContent = `
name: Trailing slash base test
repoUrl: git@github.com:example/repo.git
baseBranch: "refs/heads/"
tasks:
  - id: task1
    description: Test task
    command: echo test
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should reject baseBranch with control characters', () => {
    const yamlContent = `
name: Control char base test
repoUrl: git@github.com:example/repo.git
baseBranch: "branch\x00name"
tasks:
  - id: task1
    description: Test task
    command: echo test
`;

    expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
  });

  it('parsePlan should accept valid baseBranch', () => {
    const yamlContent = `
name: Valid base test
repoUrl: git@github.com:example/repo.git
baseBranch: "main"
tasks:
  - id: task1
    description: Test task
    command: echo test
`;

    const plan = parsePlan(yamlContent);
    expect(plan.baseBranch).toBe('main');
  });

  it('parsePlan should accept baseBranch with slashes', () => {
    const yamlContent = `
name: Feature base test
repoUrl: git@github.com:example/repo.git
baseBranch: "feature/my-branch"
tasks:
  - id: task1
    description: Test task
    command: echo test
`;

    const plan = parsePlan(yamlContent);
    expect(plan.baseBranch).toBe('feature/my-branch');
  });
});
