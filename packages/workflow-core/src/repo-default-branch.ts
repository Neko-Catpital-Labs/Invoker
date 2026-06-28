import { execFileSync } from 'node:child_process';


export function detectDefaultBranchRemote(repoUrl: string): string | undefined {
  const trimmed = repoUrl.trim();
  if (trimmed === '') return undefined;

  try {
    const output = execFileSync('git', ['ls-remote', '--symref', trimmed, 'HEAD'], {
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
  throw new Error(`Unable to resolve default branch for repo ${repoUrl}. Make the remote HEAD readable.`);
}

export function remoteBranchExists(repoUrl: string, branch: string): boolean {
  const trimmedRepo = repoUrl.trim();
  const trimmedBranch = branch.trim();
  if (trimmedRepo === '' || trimmedBranch === '') return false;

  try {
    execFileSync('git', ['ls-remote', '--exit-code', '--heads', trimmedRepo, trimmedBranch], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

export function requireRemoteBranch(repoUrl: string, branch: string): string {
  const trimmedBranch = branch.trim();
  if (trimmedBranch === '') {
    throw new Error('Target branch is required.');
  }
  if (!remoteBranchExists(repoUrl, trimmedBranch)) {
    throw new Error(`Branch "${trimmedBranch}" does not exist on repo ${repoUrl}.`);
  }
  return trimmedBranch;
}
