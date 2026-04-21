export interface BranchPushExecutor {
  exec(args: string[], cwd: string): Promise<string>;
}

const BRANCH_PUSH_RACE_PATTERNS = [
  /cannot lock ref ['"]refs\/heads\/[^'"]+['"]:\s*is at [0-9a-f]+ but expected [0-9a-f]+/i,
  /reference already exists/i,
];

export function isGitBranchPushRaceError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return BRANCH_PUSH_RACE_PATTERNS.some((pattern) => pattern.test(message));
}

async function remoteTreeMatchesLocal(
  executor: BranchPushExecutor,
  cwd: string,
  branch: string,
): Promise<boolean> {
  try {
    await executor.exec(
      ['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      cwd,
    );
    const localTree = (await executor.exec(['rev-parse', 'HEAD^{tree}'], cwd)).trim();
    const remoteTree = (await executor.exec(['rev-parse', `refs/remotes/origin/${branch}^{tree}`], cwd)).trim();
    return localTree.length > 0 && localTree === remoteTree;
  } catch {
    return false;
  }
}

export async function pushBranchWithRecovery(
  executor: BranchPushExecutor,
  cwd: string,
  branch: string,
  opts?: { maxAttempts?: number },
): Promise<void> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await executor.exec(['push', '--force', '-u', 'origin', branch], cwd);
      return;
    } catch (err) {
      lastError = err;
      if (!isGitBranchPushRaceError(err)) {
        throw err;
      }
      if (await remoteTreeMatchesLocal(executor, cwd, branch)) {
        return;
      }
      if (attempt === maxAttempts) {
        throw err;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
