/**
 * Regression test for: merge gate attempts to merge already-incorporated
 * experiment branches that no longer exist.
 *
 * Scenario: An experiment branch was merged via another path and deleted.
 * The merge gate still references it. Should skip gracefully, not fail.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { bashMergeUpstreams, runBashLocal } from '../branch-utils.js';

function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'merge-missing-'));
  execSync('git init -b master', { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  writeFileSync(join(dir, 'initial.txt'), 'initial content');
  execSync('git add -A && git commit -m "initial"', { cwd: dir });
  return dir;
}

function gitExec(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8' }).trim();
}

describe('Merge gate missing experiment branch handling', () => {
  it('skips missing experiment/* branches gracefully', async () => {
    const repoDir = createTempRepo();

    try {
      // Create experiment branch and delete it (simulates already-merged and deleted)
      gitExec('git checkout -b experiment/add-feature-abc123', repoDir);
      writeFileSync(join(repoDir, 'feature.txt'), 'feature content');
      gitExec('git add -A && git commit -m "add feature"', repoDir);
      gitExec('git checkout master', repoDir);

      // Merge into master via different path (simulates manual merge or different workflow)
      gitExec('git merge --no-ff -m "Merge feature" experiment/add-feature-abc123', repoDir);

      // Delete the experiment branch (simulates cleanup)
      gitExec('git branch -D experiment/add-feature-abc123', repoDir);

      // Create worktree from master
      const wtDir = mkdtempSync(join(tmpdir(), 'merge-wt-'));
      try {
        gitExec(`git worktree add "${wtDir}" -b test-branch master`, repoDir);

        // Attempt to merge the now-missing experiment branch
        const script = bashMergeUpstreams({
          worktreeDir: wtDir,
          upstreamBranches: ['experiment/add-feature-abc123'],
          skipAncestors: true,
        });

        // Should succeed and skip the missing branch
        const stdout = await runBashLocal(script);
        expect(stdout).toContain('SKIPPED_MISSING_REF=experiment/add-feature-abc123');
      } finally {
        rmSync(wtDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('skips missing feature branches at bash level', async () => {
    const repoDir = createTempRepo();
    const wtDir = mkdtempSync(join(tmpdir(), 'merge-wt-'));

    try {
      // Create worktree from master
      gitExec(`git worktree add "${wtDir}" -b test-branch master`, repoDir);

      // Attempt to merge a missing feature/* branch (not experiment/*)
      const script = bashMergeUpstreams({
        worktreeDir: wtDir,
        upstreamBranches: ['feature/missing-important-branch'],
        skipAncestors: true,
      });

      // Should succeed but skip (bash script doesn't differentiate branch types,
      // that's done in merge-executor.ts at a higher level)
      const stdout = await runBashLocal(script);
      expect(stdout).toContain('SKIPPED_MISSING_REF=feature/missing-important-branch');
    } finally {
      rmSync(wtDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('merges available branches and skips missing ones in mixed list', async () => {
    const repoDir = createTempRepo();
    const wtDir = mkdtempSync(join(tmpdir(), 'merge-wt-'));

    try {
      // Create one valid branch
      gitExec('git checkout -b experiment/valid-branch', repoDir);
      writeFileSync(join(repoDir, 'valid.txt'), 'valid content');
      gitExec('git add -A && git commit -m "valid change"', repoDir);
      gitExec('git checkout master', repoDir);

      // Create worktree from master
      gitExec(`git worktree add "${wtDir}" -b test-branch master`, repoDir);

      // Merge list contains both valid and missing branches
      const script = bashMergeUpstreams({
        worktreeDir: wtDir,
        upstreamBranches: [
          'experiment/missing-branch-1',
          'experiment/valid-branch',
          'experiment/missing-branch-2',
        ],
        skipAncestors: true,
      });

      const stdout = await runBashLocal(script);
      expect(stdout).toContain('SKIPPED_MISSING_REF=experiment/missing-branch-1');
      expect(stdout).toContain('SKIPPED_MISSING_REF=experiment/missing-branch-2');
      // Valid branch should be merged (no skip message for it)
      expect(stdout).not.toContain('SKIPPED_MISSING_REF=experiment/valid-branch');

      // Verify the valid branch was actually merged by checking the file exists
      const files = gitExec('git ls-files', wtDir);
      expect(files).toContain('valid.txt');
    } finally {
      rmSync(wtDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
