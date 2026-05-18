import { createHash } from 'node:crypto';

/**
 * Compute a deterministic 12-character hash of a repository URL.
 * Used for creating consistent cache directories across executors and pools.
 */
export function computeRepoUrlHash(repoUrl: string): string {
  return createHash('sha256').update(repoUrl).digest('hex').slice(0, 12);
}

/**
 * Compute a cache-only repository identity. This intentionally does not
 * replace the caller's repo URL for git remotes; it only lets equivalent
 * GitHub URL spellings share local mirror/worktree cache directories.
 */
export function computeRepoCacheKey(repoUrl: string): string {
  const normalized = normalizeGitHubRepoUrlForCache(repoUrl.trim());
  return normalized ?? repoUrl;
}

export function computeRepoCacheHash(repoUrl: string): string {
  return computeRepoUrlHash(computeRepoCacheKey(repoUrl));
}

function normalizeGitHubRepoUrlForCache(repoUrl: string): string | undefined {
  const ssh = repoUrl.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (ssh) {
    return githubKey(ssh[1], ssh[2]);
  }

  const https = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (https) {
    return githubKey(https[1], https[2]);
  }

  const sshUrl = repoUrl.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (sshUrl) {
    return githubKey(sshUrl[1], sshUrl[2]);
  }

  return undefined;
}

function githubKey(owner: string, repo: string): string {
  return `github.com/${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/**
 * Sanitize a git branch name for use as a filesystem path segment.
 * Converts slashes to hyphens to create a safe directory name.
 * Example: "experiment/task-123-abc" → "experiment-task-123-abc"
 */
export function sanitizeBranchForPath(branch: string): string {
  return branch.replace(/\//g, '-');
}
