import { execFileSync } from 'node:child_process';

export const PINNED_WORKFLOW_BASE_BRANCH = 'master';

export function normalizeWorkflowBaseBranch(_branch?: string | null): string {
  return PINNED_WORKFLOW_BASE_BRANCH;
}

export function workflowBaseBranchNeedsMigration(branch?: string | null): boolean {
  return (branch?.trim() ?? '') !== PINNED_WORKFLOW_BASE_BRANCH;
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

