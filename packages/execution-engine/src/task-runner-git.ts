/**
 * Host-free git/gh subprocess plumbing for the task runner.
 *
 * Extracted from `task-runner.ts` so the runner, merge-runner, and
 * conflict-resolver can share identical git/gh process semantics (timeout,
 * process-group kill, EXDEV clone fallback, PR idempotency) without a
 * circular import. These are plain functions over explicit parameters — the
 * same convention used by `task-runner-launch-support.ts` and
 * `pr-authoring.ts`.
 *
 * `TaskRunner` keeps thin methods that delegate here so the structural
 * `MergeRunnerHost` / `ConflictResolverHost` obligations stay unchanged.
 * The helpers that call back into git exec (`cloneMergeWorktree`,
 * `detectDefaultBranch`) receive the exec callable explicitly so an instance
 * override (e.g. a test spy on `TaskRunner.execGitReadonly`) stays observable.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

import type { Logger } from '@invoker/contracts';
import { assertNotGitConfigMutation, ensureRemoteUrl } from './git-config-mutation.js';
import { killProcessGroup, SIGKILL_TIMEOUT_MS } from './process-utils.js';
import { retryTransientGitHubCli } from './git-utils.js';
import { normalizeBranchForGithubCli } from './github-branch-ref.js';

const DEFAULT_GIT_OPERATION_TIMEOUT_MS = 15 * 60 * 1000;
const GITHUB_TARGET_REPO_ENV = 'INVOKER_GITHUB_TARGET_REPO';

/** Instance-bound readonly git exec that higher-level helpers route through so overrides stay observable. */
export type GitReadonlyExec = (args: string[]) => Promise<string>;

/** Instance-bound `gh` exec so higher-level helpers route through overrides (tests, spies). */
export type GitExecGh = (args: string[], cwd?: string) => Promise<string>;

/** Instance-bound `git` exec (explicit dir) so higher-level helpers route through overrides. */
export type GitExecIn = (args: string[], dir: string) => Promise<string>;

/** Dependencies `createMergeWorktree` needs from the owning runner. */
export interface CreateMergeWorktreeContext {
  cwd: string;
  logger: Logger;
  ensureRepoMirrorPath: (repoUrl: string) => Promise<string | undefined>;
}

function getGitOperationTimeoutMs(): number {
  const raw = process.env.INVOKER_GIT_NETWORK_TIMEOUT_MS?.trim();
  if (raw === '0') return 0;
  if (!raw) return DEFAULT_GIT_OPERATION_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_GIT_OPERATION_TIMEOUT_MS;
  return parsed;
}

function execGitWithTimeout(args: string[], cwd: string): Promise<string> {
  const { promise, resolve: resolvePromise, reject } = Promise.withResolvers<string>();
  const child = spawn('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const timeoutMs = getGitOperationTimeoutMs();
  let stdout = '';
  let stderr = '';
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const finish = (fn: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    fn();
  };

  if (timeoutMs > 0) {
    timeout = setTimeout(() => {
      killProcessGroup(child, 'SIGTERM');
      const forceKill = setTimeout(() => {
        killProcessGroup(child, 'SIGKILL');
      }, SIGKILL_TIMEOUT_MS);
      forceKill.unref?.();
      finish(() => reject(new Error(
        `git ${args.join(' ')} exceeded git operation timeout (${timeoutMs}ms) in ${cwd}. ` +
        'Set INVOKER_GIT_NETWORK_TIMEOUT_MS to adjust (0 = unbounded).',
      )));
    }, timeoutMs);
    timeout.unref?.();
  }

  child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
  child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
  child.on('error', (err) => {
    finish(() => reject(new Error(`Failed to spawn git: ${err.message}`)));
  });
  child.on('close', (code, signal) => {
    finish(() => {
      if (code === 0) {
        resolvePromise(stdout.trim());
        return;
      }
      reject(new Error(
        `git ${args.join(' ')} failed (code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}): ` +
        `${stderr.trim()}${stdout.trim() ? '\n' + stdout.trim() : ''}`,
      ));
    });
  });
  return promise;
}

/**
 * Read-only git queries only. Config mutations must use git-config-mutation helpers.
 */
export function execGitReadonly(args: string[], cwd: string): Promise<string> {
  assertNotGitConfigMutation(args, 'TaskRunner.execGitReadonly');
  return execGitWithTimeout(args, cwd);
}

export function execGitIn(args: string[], dir: string): Promise<string> {
  assertNotGitConfigMutation(args, 'TaskRunner.execGitIn');
  return execGitWithTimeout(args, dir);
}

export async function createMergeWorktree(
  ref: string,
  label: string,
  repoUrl: string | undefined,
  ctx: CreateMergeWorktreeContext,
): Promise<string> {
  const invokerHomeRoot = process.env.INVOKER_DB_DIR
    ? resolve(process.env.INVOKER_DB_DIR)
    : resolve(homedir(), '.invoker');
  const mergeCloneRoot = resolve(invokerHomeRoot, 'merge-clones');
  mkdirSync(mergeCloneRoot, { recursive: true });
  const clonePath = mkdtempSync(resolve(mergeCloneRoot, `${label}-`));

  // Determine clone source: prefer pool mirror (has latest remote refs), fall back to host repo
  let cloneSource: string = ctx.cwd;
  let originUrl: string | undefined;
  if (repoUrl) {
    const mirrorPath = await ctx.ensureRepoMirrorPath(repoUrl);
    if (mirrorPath) {
      cloneSource = mirrorPath;
      originUrl = repoUrl;
    } else {
      ctx.logger.warn(`[createMergeWorktree] Pool mirror unavailable for ${repoUrl}, falling back to host repo`);
    }
  }

  await cloneMergeWorktree(cloneSource, clonePath, (args) => execGitReadonly(args, ctx.cwd), ctx.logger);
  // Detach HEAD so the fetch can overwrite all branch refs (including the default branch)
  const headSha = (await execGitIn(['rev-parse', 'HEAD'], clonePath)).trim();
  await execGitIn(['update-ref', '--no-deref', 'HEAD', headSha], clonePath);
  // Mirror all branches as local refs so bare branch names resolve.
  await execGitIn(['fetch', 'origin', '+refs/heads/*:refs/heads/*'], clonePath);

  // Reconfigure origin to the real remote URL (GitHub) so subsequent push/fetch
  // operations go directly to GitHub, bypassing any intermediate clone.
  if (!originUrl) {
    // Fallback: read origin from the host repo (old behavior)
    originUrl = (await execGitReadonly(['remote', 'get-url', 'origin'], ctx.cwd)).trim();
  }
  await ensureRemoteUrl({
    cwd: clonePath,
    remote: 'origin',
    url: originUrl,
    context: { caller: 'TaskRunner.createMergeWorktree', detail: `${label}:${ref}` },
  });

  // Refresh the requested base branch from the real remote. The pool mirror's
  // local refs/heads/* can go stale after force-pushes or history rewrites,
  // causing merge conflicts when experiment branches are based on the new
  // history but the clone got the old branch tip from the pool.
  const normalizedRef = ref.trim();
  const strippedRemoteRef = normalizeBranchForGithubCli(normalizedRef);
  const remoteName = 'origin';
  const baseRef = normalizedRef.startsWith('origin/')
    ? normalizedRef.slice('origin/'.length)
    : strippedRemoteRef;
  // `--` (end-of-options) before the remote/refspec: baseRef is derived from the caller-supplied
  // ref, so stop git option parsing to block argument injection (CodeQL js/second-order-command-line-injection).
  try {
    await execGitIn(
      ['fetch', '--', remoteName, `+refs/heads/${baseRef}:refs/remotes/${remoteName}/${baseRef}`],
      clonePath,
    );
  } catch {
    // Non-critical: pool's ref may still be valid
  }

  // Resolve ref in the clone (not in host repo — the clone has mirrored branches).
  // Accept both "feature/x" and "origin/feature/x" forms, and tolerate missing
  // origin tracking refs for local-only stacked branches.
  const tryResolve = async (expr: string): Promise<string | undefined> => {
    try {
      return (await execGitIn(['rev-parse', '--verify', `${expr}^{commit}`], clonePath)).trim();
    } catch {
      return undefined;
    }
  };

  const candidates = Array.from(new Set([
    `refs/remotes/${remoteName}/${baseRef}`,
    `${remoteName}/${baseRef}`,
    normalizedRef,
    strippedRemoteRef,
    `refs/heads/${strippedRemoteRef}`,
  ]));

  let refSha: string | undefined;
  for (const candidate of candidates) {
    refSha = await tryResolve(candidate);
    if (refSha) break;
  }

  if (!refSha) {
    // Last chance: fetch only the requested branch from origin, then retry.
    // This can happen if clone source had stale refs at submit time.
    try {
      await execGitIn(
        ['fetch', '--', remoteName, `+refs/heads/${strippedRemoteRef}:refs/remotes/${remoteName}/${strippedRemoteRef}`],
        clonePath,
      );
    } catch {
      // Best-effort; keep error message from final resolve below.
    }
    for (const candidate of candidates) {
      refSha = await tryResolve(candidate);
      if (refSha) break;
    }
  }

  // Fallback: if the requested ref is one of the common default branch names
  // and it doesn't exist, try the alternate (main↔master). Plan YAML files
  // sometimes specify "main" for repos whose default branch is "master" or
  // vice versa.
  if (!refSha) {
    const alternates: Record<string, string> = { main: 'master', master: 'main' };
    const alt = alternates[strippedRemoteRef];
    if (alt) {
      try {
        await execGitIn(
          ['fetch', '--', remoteName, `+refs/heads/${alt}:refs/remotes/${remoteName}/${alt}`],
          clonePath,
        );
      } catch {
        // Best-effort
      }
      const altCandidates = [
        `refs/remotes/${remoteName}/${alt}`,
        `${remoteName}/${alt}`,
        alt,
        `refs/heads/${alt}`,
      ];
      for (const candidate of altCandidates) {
        refSha = await tryResolve(candidate);
        if (refSha) break;
      }
    }
  }

  if (!refSha) {
    throw new Error(
      `Branch "${ref}" required by the merge/gate step was not found on the remote (${originUrl}). ` +
      `This branch is retrieved from origin, but it is not there — it was never pushed to origin, ` +
      `or it has since been deleted. Push the branch to origin (or point the workflow's base at a ` +
      `branch that exists on origin), then rerun the gate. Recreating the task alone will not help ` +
      `while the branch is missing from origin. ` +
      `(resolved in clone ${clonePath}; tried ${candidates.join(', ')})`,
    );
  }
  await execGitIn(['checkout', '--detach', refSha], clonePath);
  return clonePath;
}

export async function cloneMergeWorktree(
  cloneSource: string,
  clonePath: string,
  execGitReadonly: GitReadonlyExec,
  logger: Logger,
): Promise<void> {
  try {
    // Hard-linked objects make local pool clones near-instant while keeping refs isolated.
    // `--` (end-of-options): cloneSource is caller-derived (pool mirror / repoUrl), so stop git
    // option parsing before it to block argument injection (CodeQL js/second-order-command-line-injection).
    await execGitReadonly(['clone', '--local', '--no-checkout', '--', cloneSource, clonePath]);
  } catch (err) {
    const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    if (!message.includes('Invalid cross-device link') && !message.includes('EXDEV')) {
      throw err;
    }

    // CI may place the repo/mirror and temp merge clone on different mounts,
    // where Git's hardlink-based local clone fails with EXDEV.
    logger.warn(
      `[createMergeWorktree] Local clone crossed filesystems; retrying without hardlinks: ${message.split('\n')[0]}`,
    );
    rmSync(clonePath, { recursive: true, force: true });
    await execGitReadonly(['clone', '--no-local', '--no-checkout', '--', cloneSource, clonePath]);
  }
}

export async function removeMergeWorktree(dir: string, logger: Logger): Promise<void> {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    logger.warn('[TaskRunner] removeMergeWorktree failed (best-effort)', {
      dir,
      error: err instanceof Error ? err.message : String(err),
      err,
    });
  }
}

export async function detectDefaultBranch(execGitReadonly: GitReadonlyExec): Promise<string> {
  try {
    const ref = await execGitReadonly(['symbolic-ref', 'refs/remotes/origin/HEAD']);
    return ref.replace('refs/remotes/origin/', '');
  } catch {
    try {
      await execGitReadonly(['rev-parse', '--verify', 'main']);
      return 'main';
    } catch {
      return 'master';
    }
  }
}

export function execGh(args: string[], cwd: string): Promise<string> {
  const { promise, resolve: resolvePromise, reject } = Promise.withResolvers<string>();
  const child = spawn('gh', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
  child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
  child.on('close', (code) => {
    if (code === 0) resolvePromise(stdout.trim());
    else reject(new Error(`gh ${args[0]} ${args[1]} failed (code ${code}): ${stderr.trim()}`));
  });
  return promise;
}

export async function execPr(
  baseBranch: string,
  featureBranch: string,
  title: string,
  body: string | undefined,
  cwd: string,
  execGh: GitExecGh,
  execGitIn: GitExecIn,
): Promise<string> {
  const ghBase = normalizeBranchForGithubCli(baseBranch);
  const ghHead = normalizeBranchForGithubCli(featureBranch);
  const effectiveCwd = cwd;
  const targetRepo = await resolveGithubTargetRepo(effectiveCwd, execGitIn);
  const repoOwner = targetRepo.split('/')[0];

  const listOutput = await retryTransientGitHubCli(() => execGh([
    'api', `repos/${targetRepo}/pulls`,
    '--method', 'GET',
    '-f', `head=${repoOwner}:${ghHead}`,
    '-f', 'state=open',
    '-f', 'per_page=1',
  ], effectiveCwd));

  const existing: Array<{ html_url?: string; url?: string; number: number }> = JSON.parse(listOutput || '[]');
  if (existing.length > 0) {
    const pr = existing[0];
    const editArgs = [
      'api', `repos/${targetRepo}/pulls/${pr.number}`,
      '--method', 'PATCH',
      '-f', `base=${ghBase}`,
      '-f', `title=${title}`,
    ];
    if (body) editArgs.push('-f', `body=${body}`);
    await retryTransientGitHubCli(() => execGh(editArgs, effectiveCwd));
    return pr.html_url ?? pr.url ?? '';
  }

  const createOutput = await execGh([
    'api', `repos/${targetRepo}/pulls`,
    '--method', 'POST',
    '-f', `base=${ghBase}`,
    '-f', `head=${ghHead}`,
    '-f', `title=${title}`,
    '-f', `body=${body ?? ''}`,
  ], effectiveCwd);
  try {
    const pr = JSON.parse(createOutput) as { html_url?: string; url?: string };
    return pr.html_url ?? pr.url ?? createOutput;
  } catch {
    return createOutput;
  }
}

async function resolveGithubTargetRepo(cwd: string, execGitIn: GitExecIn): Promise<string> {
  const explicitTarget = process.env[GITHUB_TARGET_REPO_ENV]?.trim();
  if (explicitTarget) {
    if (/^[^/\s]+\/[^/\s]+$/.test(explicitTarget)) return explicitTarget;
    throw new Error(
      `Invalid ${GITHUB_TARGET_REPO_ENV}="${explicitTarget}". Expected format "owner/repo".`,
    );
  }

  try {
    const url = await execGitIn(['remote', 'get-url', 'origin'], cwd);
    const parsed = parseGitHubRepoNwo(url);
    if (parsed) return parsed;
  } catch {
    // fall through
  }

  throw new Error(
    'Unable to resolve GitHub target repo. ' +
    `Set ${GITHUB_TARGET_REPO_ENV}=owner/repo or configure a parseable origin GitHub remote.`,
  );
}

function parseGitHubRepoNwo(url: string): string | undefined {
  const m = url.trim().match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?\/?$/i);
  return m?.[1];
}

export function gitLogMessage(commitHash: string, cwd: string): Promise<string> {
  const { promise, resolve: resolvePromise, reject } = Promise.withResolvers<string>();
  const child = spawn('git', ['log', '-1', '--format=%B', commitHash], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
  child.on('error', (err) => {
    reject(new Error(`Failed to spawn git: ${err.message}`));
  });
  child.on('close', (code) => {
    if (code === 0) resolvePromise(stdout.trim());
    else reject(new Error(`git log failed (code ${code})`));
  });
  return promise;
}

export function gitDiffStat(branch: string, defaultBranch: string | undefined, cwd: string): Promise<string> {
  const { promise, resolve: resolvePromise, reject } = Promise.withResolvers<string>();
  const baseBranch = defaultBranch ?? 'master';
  const child = spawn('git', ['diff', '--stat', '--stat-count=20', `${baseBranch}...${branch}`], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
  child.on('error', (err) => {
    reject(new Error(`Failed to spawn git: ${err.message}`));
  });
  child.on('close', (code) => {
    if (code === 0) resolvePromise(stdout.trim());
    else reject(new Error(`git diff --stat failed (code ${code})`));
  });
  return promise;
}
