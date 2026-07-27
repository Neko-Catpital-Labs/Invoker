import { execFileSync } from 'node:child_process';

const HEADS_PREFIX = 'refs/heads/';
const REMOTES_PREFIX = 'refs/remotes/';

export function normalizeWorkflowBaseBranch(branch?: string | null, fallback = 'master'): string {
  const trimmed = branch?.trim() ?? '';
  if (!trimmed) return fallback;
  if (trimmed.startsWith(HEADS_PREFIX)) {
    return trimmed.slice(HEADS_PREFIX.length);
  }
  if (trimmed.startsWith(REMOTES_PREFIX)) {
    return trimmed.slice(REMOTES_PREFIX.length);
  }
  return trimmed;
}

export function workflowBaseBranchNeedsMigration(branch?: string | null, fallback = 'master'): boolean {
  const trimmed = branch?.trim() ?? '';
  return normalizeWorkflowBaseBranch(branch, fallback) !== trimmed;
}

export function detectDefaultBranchRemote(repoUrl: string): string | undefined {
  const trimmed = repoUrl.trim();
  if (trimmed === '') return undefined;

  try {
    const output = execFileSync('git', ['ls-remote', '--symref', '--', trimmed, 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
    return output.match(/ref:\s+refs\/heads\/(\S+)\s+HEAD/)?.[1];
  } catch {
    return undefined;
  }
}

export function requireDefaultBranchRemote(repoUrl: string): string {
  const branch = detectDefaultBranchRemote(repoUrl);
  if (branch) return branch;
  throw new Error('Unable to resolve default branch for repo. Make the remote HEAD readable.');
}

