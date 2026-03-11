import { execSync } from 'node:child_process';

export interface CleanupResult {
  removed: string[];
  errors: string[];
}

/**
 * Parses `git worktree list --porcelain` output into entries.
 * Each entry has a `path` and optional `branch` (without refs/heads/ prefix).
 */
export function parseWorktreeList(output: string): Array<{ path: string; branch?: string }> {
  const entries: Array<{ path: string; branch?: string }> = [];
  let current: { path: string; branch?: string } | null = null;

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('branch refs/heads/') && current) {
      current.branch = line.slice('branch refs/heads/'.length);
    }
  }
  if (current) entries.push(current);

  return entries;
}

/**
 * Removes git worktrees whose branch is not in the set of known branches
 * from the DB. Also deletes the orphan branches and runs prune.
 */
export function cleanupOrphanWorktrees(
  repoDir: string,
  knownBranches: Set<string>,
): CleanupResult {
  const result: CleanupResult = { removed: [], errors: [] };

  let porcelain: string;
  try {
    porcelain = execSync('git worktree list --porcelain', {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    result.errors.push('Failed to list worktrees');
    return result;
  }

  const entries = parseWorktreeList(porcelain);

  for (const entry of entries) {
    if (!entry.branch?.startsWith('experiment/')) continue;
    if (knownBranches.has(entry.branch)) continue;

    // Orphan worktree — remove it
    try {
      execSync(`git worktree remove --force "${entry.path}"`, {
        cwd: repoDir,
        stdio: 'ignore',
      });
      result.removed.push(entry.branch);
    } catch {
      result.errors.push(`Failed to remove worktree for ${entry.branch} at ${entry.path}`);
    }

    // Delete the orphan branch
    try {
      execSync(`git branch -D "${entry.branch}"`, {
        cwd: repoDir,
        stdio: 'ignore',
      });
    } catch {
      // Branch may already be deleted or never existed locally
    }
  }

  // Final prune to clean up any dangling references
  try {
    execSync('git worktree prune', { cwd: repoDir, stdio: 'ignore' });
  } catch {
    result.errors.push('Failed to run git worktree prune');
  }

  return result;
}
