/**
 * Repro: featureBranch must be a safe git ref
 *
 * Symptoms:
 * - Emoji-only `🔥` and name `..` slug to `featureBranch: "plan/"` (empty slug)
 * - Explicit `featureBranch: ../w3-escape-branch` stored unsanitized
 *
 * Root cause: parsePlan does not validate featureBranch as a valid git ref.
 * Invalid refs can cause git operations to fail or behave unexpectedly.
 *
 * Invariant: featureBranch must be a valid git ref - no empty slugs,
 * trailing slashes, path escapes, or control characters.
 *
 * Fix applied:
 * - parsePlan now validates featureBranch with isValidGitRef()
 * - Invalid refs are rejected with a clear error message
 */

import { describe, it, expect } from 'vitest';
import { parsePlan, PlanParseError, isValidGitRef } from '../plan-parser.js';

describe('featureBranch validation', () => {
  describe('isValidGitRef helper', () => {
    it('rejects empty string', () => {
      expect(isValidGitRef('')).toBe(false);
    });

    it('rejects whitespace-only', () => {
      expect(isValidGitRef('   ')).toBe(false);
    });

    it('rejects path traversal with ..', () => {
      expect(isValidGitRef('../escape')).toBe(false);
      expect(isValidGitRef('foo/../bar')).toBe(false);
    });

    it('rejects leading slash', () => {
      expect(isValidGitRef('/absolute')).toBe(false);
    });

    it('rejects trailing slash', () => {
      expect(isValidGitRef('plan/')).toBe(false);
      expect(isValidGitRef('feature/test/')).toBe(false);
    });

    it('rejects double slash', () => {
      expect(isValidGitRef('foo//bar')).toBe(false);
    });

    it('rejects hidden component', () => {
      expect(isValidGitRef('.hidden')).toBe(false);
      expect(isValidGitRef('foo/.hidden')).toBe(false);
    });

    it('rejects .lock suffix', () => {
      expect(isValidGitRef('branch.lock')).toBe(false);
    });

    it('rejects reflog syntax', () => {
      expect(isValidGitRef('branch@{1}')).toBe(false);
    });

    it('rejects backslash', () => {
      expect(isValidGitRef('foo\\bar')).toBe(false);
    });

    it('rejects control characters', () => {
      expect(isValidGitRef('foo\x00bar')).toBe(false);
      expect(isValidGitRef('foo\x1fbar')).toBe(false);
    });

    it('rejects special git characters', () => {
      expect(isValidGitRef('foo~bar')).toBe(false);
      expect(isValidGitRef('foo^bar')).toBe(false);
      expect(isValidGitRef('foo:bar')).toBe(false);
      expect(isValidGitRef('foo?bar')).toBe(false);
      expect(isValidGitRef('foo*bar')).toBe(false);
      expect(isValidGitRef('foo[bar')).toBe(false);
    });

    it('accepts valid branch names', () => {
      expect(isValidGitRef('main')).toBe(true);
      expect(isValidGitRef('feature/test')).toBe(true);
      expect(isValidGitRef('plan/my-feature')).toBe(true);
      expect(isValidGitRef('fix-123')).toBe(true);
    });

    it('rejects flag-like refs starting with hyphen', () => {
      expect(isValidGitRef('-u')).toBe(false);
      expect(isValidGitRef('-d')).toBe(false);
      expect(isValidGitRef('--force')).toBe(false);
    });

    it('rejects reserved git refs', () => {
      expect(isValidGitRef('HEAD')).toBe(false);
      expect(isValidGitRef('FETCH_HEAD')).toBe(false);
      expect(isValidGitRef('ORIG_HEAD')).toBe(false);
      expect(isValidGitRef('MERGE_HEAD')).toBe(false);
    });

    it('rejects remote-prefixed refs', () => {
      expect(isValidGitRef('origin/master')).toBe(false);
      expect(isValidGitRef('upstream/main')).toBe(false);
      expect(isValidGitRef('remote/feature')).toBe(false);
    });

    it('rejects refs/heads/.. path escape', () => {
      expect(isValidGitRef('refs/heads/..')).toBe(false);
      expect(isValidGitRef('refs/heads/../etc')).toBe(false);
    });
  });

  describe('parsePlan featureBranch validation', () => {
    it('rejects featureBranch with path traversal', () => {
      const yamlContent = `
name: Escape test
repoUrl: git@github.com:example/repo.git
featureBranch: "../w3-escape-branch"
tasks:
  - id: task1
    description: Test task
    command: echo test
`;

      expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
    });

    it('rejects featureBranch with trailing slash (empty slug)', () => {
      const yamlContent = `
name: Empty slug test
repoUrl: git@github.com:example/repo.git
featureBranch: "plan/"
tasks:
  - id: task1
    description: Test task
    command: echo test
`;

      expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
    });

    it('rejects empty featureBranch', () => {
      const yamlContent = `
name: Empty branch test
repoUrl: git@github.com:example/repo.git
featureBranch: ""
tasks:
  - id: task1
    description: Test task
    command: echo test
`;

      expect(() => parsePlan(yamlContent)).toThrow(PlanParseError);
    });

    it('accepts valid featureBranch', () => {
      const yamlContent = `
name: Valid branch test
repoUrl: git@github.com:example/repo.git
featureBranch: "feature/my-branch"
tasks:
  - id: task1
    description: Test task
    command: echo test
`;

      const plan = parsePlan(yamlContent);
      expect(plan.featureBranch).toBe('feature/my-branch');
    });

    it('uses default featureBranch when not provided', () => {
      const yamlContent = `
name: Default branch test
repoUrl: git@github.com:example/repo.git
tasks:
  - id: task1
    description: Test task
    command: echo test
`;

      const plan = parsePlan(yamlContent);
      expect(plan.featureBranch).toBe('plan/default-branch-test');
    });
  });
});
