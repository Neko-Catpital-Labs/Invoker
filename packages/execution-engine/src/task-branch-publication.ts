import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const FULL_COMMIT_RE = /^[0-9a-f]{40}$/i;

export type TaskBranchPublicationVerification =
  | { ok: true; remoteHead: string }
  | { ok: false; error: string; remoteHead?: string };

export function shouldVerifyTaskBranchPublication(opts: {
  repoUrl?: string;
  branch?: string;
  commitHash?: string;
}): opts is { repoUrl: string; branch: string; commitHash: string } {
  const repoUrl = opts.repoUrl?.trim();
  const branch = opts.branch?.trim();
  const commitHash = opts.commitHash?.trim();
  if (!repoUrl || !branch || !commitHash) return false;
  if (!FULL_COMMIT_RE.test(commitHash)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(repoUrl) && !/^(https?|ssh|file|git):\/\//i.test(repoUrl)) {
    return false;
  }
  return true;
}

export async function verifyTaskBranchPublication(opts: {
  repoUrl: string;
  branch: string;
  commitHash: string;
  timeoutMs?: number;
}): Promise<TaskBranchPublicationVerification> {
  const tmp = await mkdtemp(join(tmpdir(), 'invoker-task-handoff-'));
  const timeout = opts.timeoutMs ?? 30_000;
  const git = async (args: string[]): Promise<string> => {
    const result = await execFileAsync('git', args, {
      cwd: tmp,
      encoding: 'utf8',
      timeout,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  };

  try {
    await git(['init', '-q']);
    await git(['remote', 'add', 'branch-remote', opts.repoUrl]);
    await git([
      'fetch',
      '--no-tags',
      'branch-remote',
      `+refs/heads/${opts.branch}:refs/remotes/branch-remote/${opts.branch}`,
    ]);
    const remoteRef = `refs/remotes/branch-remote/${opts.branch}`;
    const remoteHead = await git(['rev-parse', `${remoteRef}^{commit}`]);
    try {
      await git(['rev-parse', '--verify', `${opts.commitHash}^{commit}`]);
    } catch (error) {
      return {
        ok: false,
        remoteHead,
        error:
          `recorded commitHash ${opts.commitHash} is not reachable from a fresh fetch of ` +
          `branch ${opts.branch}; remote branch resolves to ${remoteHead}`,
      };
    }
    if (remoteHead !== opts.commitHash) {
      return {
        ok: false,
        remoteHead,
        error:
          `remote branch ${opts.branch} resolves to ${remoteHead}, ` +
          `not recorded commitHash ${opts.commitHash}`,
      };
    }
    return { ok: true, remoteHead };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `could not verify branch ${opts.branch} on a fresh fetch: ${detail}`,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
