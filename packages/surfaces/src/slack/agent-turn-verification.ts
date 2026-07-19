import { execFileSync } from 'node:child_process';

export interface RepoState {
  headSha: string | null;
  statusPorcelain: string;
}

function runGit(workingDir: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: workingDir, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

export async function captureRepoState(workingDir?: string): Promise<RepoState | null> {
  if (!workingDir) return null;

  const statusPorcelain = runGit(workingDir, ['status', '--porcelain']);
  if (statusPorcelain === null) return null;

  return {
    headSha: runGit(workingDir, ['rev-parse', 'HEAD']),
    statusPorcelain,
  };
}

export function repoStateUnchanged(before: RepoState | null, after: RepoState | null): boolean {
  return before !== null
    && after !== null
    && before.headSha === after.headSha
    && before.statusPorcelain === after.statusPorcelain;
}

export function looksLikeCompletionClaim(replyText: string): boolean {
  return /\b(?:fixed|implemented|completed)\b|^\s*changed\s*:|\bverified\s*:|\btests?\s+passed\b|\bbuild\s+passed\b/mui.test(replyText);
}

export function buildUnverifiedNotice(): string {
  return 'Note: no working-tree changes or new commits were detected in this session checkout, so this completion summary could not be verified.';
}
