import { createHash } from 'node:crypto';

/**
 * Compute a deterministic 12-character hash of a repository URL.
 * Used for creating consistent cache directories across familiars and pools.
 */
export function computeRepoUrlHash(repoUrl: string): string {
  return createHash('sha256').update(repoUrl).digest('hex').slice(0, 12);
}

/**
 * Sanitize a git branch name for use as a filesystem path segment.
 * Converts slashes to hyphens to create a safe directory name.
 * Example: "experiment/task-123-abc" → "experiment-task-123-abc"
 */
export function sanitizeBranchForPath(branch: string): string {
  return branch.replace(/\//g, '-');
}
