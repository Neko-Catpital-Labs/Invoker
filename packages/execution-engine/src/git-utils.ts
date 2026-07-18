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

export function isGitRefLockRace(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /cannot lock ref\b/i.test(message)
    && (
      /reference already exists/i.test(message)
      || /\bis at\b.+\bbut expected\b/i.test(message)
    );
}

export function isTransientGitHubCliError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\bi\/o timeout\b/i.test(message)
    || /\bcontext deadline exceeded\b/i.test(message)
    || /\bconnection (?:reset|refused|timed out)\b/i.test(message)
    || /\bECONNRESET\b|\bETIMEDOUT\b|\bEAI_AGAIN\b|\bENOTFOUND\b/i.test(message)
    || /\b(?:502|503|504)\b/.test(message)
    || /\bbad gateway\b|\bservice unavailable\b|\bgateway timeout\b/i.test(message)
    || /\brate limit\b/i.test(message);
}

export async function retryTransientGitHubCli<T>(
  operation: () => Promise<T>,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 250;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || !isTransientGitHubCliError(err)) {
        throw err;
      }
      await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw lastErr;
}
