import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { normalize } from 'node:path';
import { bashPreserveOrReset, runBashLocal } from './branch-utils.js';
import { RESTART_TO_BRANCH_TRACE, traceExecution } from './exec-trace.js';
import {
  abbrevRefMatchesBranch,
  canonicalPathForComparison,
  findManagedWorktreeByActionId,
  findManagedWorktreeForBranch,
} from './worktree-discovery.js';
import { syncPlanBaseRemoteForRef, isInvokerManagedPoolBranch } from './plan-base-remote.js';
import { remoteFetchForPool } from './remote-fetch-policy.js';
import { computeRepoUrlHash, sanitizeBranchForPath } from './git-utils.js';

export interface RepoPoolConfig {
  cacheDir: string;
  maxWorktrees?: number;
  /** When set, worktrees are created here instead of inside the clone. */
  worktreeBaseDir?: string;
}

export interface AcquiredWorktree {
  clonePath: string;
  worktreePath: string;
  branch: string;
  release: () => Promise<void>;
  /** Free the pool slot without removing the worktree from disk. */
  softRelease: () => void;
}

export class ResourceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceLimitError';
  }
}

export class RepoPool {
  private readonly cacheDir: string;
  private readonly maxWorktrees: number;
  private readonly worktreeBaseDir?: string;
  private activeWorktrees = new Map<string, Set<string>>();
  private cloneLocks = new Map<string, Promise<string>>();
  /** Chain of operations per repo to serialize git operations. */
  private repoChains = new Map<string, Promise<unknown>>();

  constructor(config: RepoPoolConfig) {
    this.cacheDir = config.cacheDir;
    this.maxWorktrees = config.maxWorktrees ?? 5;
    this.worktreeBaseDir = config.worktreeBaseDir;
  }

  private cloneDir(repoUrl: string): string {
    return `${this.cacheDir}/${computeRepoUrlHash(repoUrl)}`;
  }

  /** Deterministic external worktree path for a branch (requires worktreeBaseDir). */
  externalWorktreePath(repoUrl: string, branch: string): string {
    if (!this.worktreeBaseDir) {
      throw new Error('RepoPool.externalWorktreePath requires worktreeBaseDir');
    }
    const sanitized = sanitizeBranchForPath(branch);
    return `${this.worktreeBaseDir}/${computeRepoUrlHash(repoUrl)}/${sanitized}`;
  }

  /**
   * Force-fetch mirror and sync origin/<baseBranch> (rebase-and-retry). Ignores remoteFetchForPool.
   */
  async refreshMirrorForRebase(repoUrl: string, baseBranch: string, parentRemote = 'upstream'): Promise<string> {
    const prev = this.repoChains.get(repoUrl) ?? Promise.resolve();
    const next = prev.then(() => this.doRefreshMirrorForRebase(repoUrl, baseBranch, parentRemote));
    this.repoChains.set(repoUrl, next.catch(() => {}));
    return next;
  }

  private async doRefreshMirrorForRebase(repoUrl: string, baseBranch: string, parentRemote: string): Promise<string> {
    const dir = this.cloneDir(repoUrl);
    if (existsSync(dir)) {
      try {
        await this.execGit(['fetch', '--all', '--prune'], dir);
      } catch (err) {
        console.warn(`[RepoPool] refreshMirrorForRebase fetch failed: ${err}`);
      }
      try {
        const branch = (await this.execGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir)).trim();
        if (branch !== 'HEAD') {
          await this.execGit(['merge', '--ff-only', `origin/${branch}`], dir);
        }
      } catch { /* non-ff or detached */ }
    } else {
      mkdirSync(this.cacheDir, { recursive: true });
      await this.execGit(['clone', repoUrl, dir], this.cacheDir);
    }
    const runGit = (args: string[]) => this.execGit(args, dir);
    await syncPlanBaseRemoteForRef(runGit, baseBranch, parentRemote);
    return dir;
  }

  /**
   * Remove Invoker-managed branches (experiment/*, invoker/*) from the mirror and linked worktrees.
   */
  async removeManagedBranchesInMirror(repoUrl: string, branches: string[]): Promise<void> {
    const prev = this.repoChains.get(repoUrl) ?? Promise.resolve();
    const next = prev.then(() => this.doRemoveManagedBranchesInMirror(repoUrl, branches));
    this.repoChains.set(repoUrl, next.catch(() => {}));
    return next;
  }

  private async doRemoveManagedBranchesInMirror(repoUrl: string, branches: string[]): Promise<void> {
    const dir = this.cloneDir(repoUrl);
    if (!existsSync(dir) || !this.worktreeBaseDir) return;
    for (const branch of branches) {
      if (!isInvokerManagedPoolBranch(branch)) continue;
      const sanitized = sanitizeBranchForPath(branch);
      const wtPath = `${this.worktreeBaseDir}/${computeRepoUrlHash(repoUrl)}/${sanitized}`;
      try {
        await this.execGit(['worktree', 'remove', '--force', wtPath], dir);
      } catch {
        /* not registered */
      }
      if (existsSync(wtPath)) {
        try {
          rmSync(wtPath, { recursive: true, force: true });
        } catch { /* */ }
      }
      try {
        await this.execGit(['branch', '-D', branch], dir);
      } catch {
        /* missing or checked out elsewhere */
      }
    }
  }

  async ensureClone(repoUrl: string): Promise<string> {
    // Serialize clone operations per repo to prevent concurrent clone races
    const existing = this.cloneLocks.get(repoUrl);
    if (existing) return existing;

    const promise = this.doEnsureClone(repoUrl);
    this.cloneLocks.set(repoUrl, promise);
    try {
      return await promise;
    } finally {
      this.cloneLocks.delete(repoUrl);
    }
  }

  /**
   * Drop leftover worktree registration and/or directory from a prior run (crash, restart,
   * or release never called). Without this, `git worktree add` fails with "already exists".
   */
  private async reconcileStaleWorktreePath(clonePath: string, worktreePath: string): Promise<void> {
    try {
      await this.execGit(['worktree', 'remove', '--force', worktreePath], clonePath);
    } catch {
      /* not registered with this clone */
    }
    if (existsSync(worktreePath)) {
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        /* best-effort; bashPreserveOrReset will surface failure */
      }
    }
  }

  private async doEnsureClone(repoUrl: string): Promise<string> {
    const dir = this.cloneDir(repoUrl);
    if (existsSync(dir)) {
      if (remoteFetchForPool.enabled) {
        try {
          await this.execGit(['fetch', '--all', '--prune'], dir);
        } catch (err) {
          console.warn(`[RepoPool] doEnsureClone fetch failed: ${err}`);
        }
        // Advance local HEAD branch to match origin so rev-parse returns the fresh ref
        try {
          const branch = (await this.execGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir)).trim();
          if (branch !== 'HEAD') {
            await this.execGit(['merge', '--ff-only', `origin/${branch}`], dir);
          }
        } catch { /* non-ff or detached; leave as-is */ }
      }
      return dir;
    }
    mkdirSync(this.cacheDir, { recursive: true });
    await this.execGit(['clone', repoUrl, dir], this.cacheDir);
    return dir;
  }

  async acquireWorktree(repoUrl: string, branch: string, base?: string, actionId?: string): Promise<AcquiredWorktree> {
    // Serialize per-repo to prevent concurrent git worktree operations
    const prev = this.repoChains.get(repoUrl) ?? Promise.resolve();
    const next = prev.then(() => this.doAcquireWorktree(repoUrl, branch, base, actionId));
    this.repoChains.set(repoUrl, next.catch(() => {}));
    return next;
  }

  private async doAcquireWorktree(repoUrl: string, branch: string, base?: string, actionId?: string): Promise<AcquiredWorktree> {
    traceExecution(
      `${RESTART_TO_BRANCH_TRACE} RepoPool.doAcquireWorktree branch=${branch} (bashPreserveOrReset here; BaseExecutor.setupTaskBranch is not used for this path)`,
    );
    const clonePath = await this.ensureClone(repoUrl);
    const active = this.activeWorktrees.get(repoUrl) ?? new Set();
    if (active.size >= this.maxWorktrees) {
      throw new ResourceLimitError(`Worktree limit reached for ${repoUrl}: ${active.size}/${this.maxWorktrees}`);
    }
    const sanitized = sanitizeBranchForPath(branch);
    const urlHash = computeRepoUrlHash(repoUrl);
    const worktreePath = this.worktreeBaseDir
      ? `${this.worktreeBaseDir}/${urlHash}/${sanitized}`
      : `${clonePath}/worktrees/${sanitized}`;
    const worktreeParent = worktreePath.substring(0, worktreePath.lastIndexOf('/'));
    const managedPrefixes = [
      normalize(
        this.worktreeBaseDir
          ? `${this.worktreeBaseDir}/${urlHash}`
          : `${clonePath}/worktrees`,
      ),
    ];

    let porcelain = '';
    try {
      porcelain = await this.execGit(['worktree', 'list', '--porcelain'], clonePath);
    } catch {
      porcelain = '';
    }

    let effectivePath = worktreePath;
    let reusedExisting = false;
    const reuseCandidate = findManagedWorktreeForBranch(porcelain, branch, managedPrefixes);
    if (reuseCandidate && existsSync(reuseCandidate)) {
      try {
        const head = (await this.execGit(['rev-parse', '--abbrev-ref', 'HEAD'], reuseCandidate)).trim();
        if (abbrevRefMatchesBranch(head, branch)) {
          effectivePath = reuseCandidate;
          reusedExisting = true;
          traceExecution(
            `${RESTART_TO_BRANCH_TRACE} RepoPool.doAcquireWorktree reuse existing worktree path=${effectivePath} branch=${branch}`,
          );
        }
      } catch {
        /* fall through to create */
      }
    }

    // Fallback: reuse worktree for same actionId but different hash (preserves conflict resolutions).
    // Only reuse when the new `base` is an ancestor of the existing worktree's HEAD — this means
    // the worktree already contains the caller's base revision and only the experiment commits are
    // "extra" (e.g. conflict resolution). If `base` has advanced beyond what the worktree contains
    // (e.g. master moved forward and rebaseAndRetry/bumpGeneration wants a fresh branch from the
    // new base), skip reuse and fall through to fresh creation.
    if (!reusedExisting && actionId) {
      const actionIdHit = findManagedWorktreeByActionId(porcelain, actionId, managedPrefixes);
      if (actionIdHit && existsSync(actionIdHit.path)) {
        let baseIsAncestorOfHead = true;
        if (base) {
          try {
            await this.execGit(['merge-base', '--is-ancestor', base, 'HEAD'], actionIdHit.path);
            // exit 0 → base is ancestor of HEAD → worktree is up-to-date with caller's base
          } catch {
            baseIsAncestorOfHead = false;
          }
        }
        if (baseIsAncestorOfHead) {
          try {
            await this.execGit(['branch', '-m', actionIdHit.branch, branch], actionIdHit.path);
            const head = (await this.execGit(['rev-parse', '--abbrev-ref', 'HEAD'], actionIdHit.path)).trim();
            if (abbrevRefMatchesBranch(head, branch)) {
              effectivePath = actionIdHit.path;
              reusedExisting = true;
              traceExecution(
                `${RESTART_TO_BRANCH_TRACE} RepoPool.doAcquireWorktree reuse by actionId: renamed ${actionIdHit.branch} → ${branch} path=${effectivePath}`,
              );
            }
          } catch { /* fall through to create fresh */ }
        } else {
          traceExecution(
            `${RESTART_TO_BRANCH_TRACE} RepoPool.doAcquireWorktree skip actionId reuse: base=${base?.slice(0, 8) ?? 'unset'} is not ancestor of HEAD at ${actionIdHit.path} (base advanced → fresh branch)`,
          );
        }
      }
    }

    if (!reusedExisting) {
      await this.reconcileStaleWorktreePath(clonePath, worktreePath);
      mkdirSync(worktreeParent, { recursive: true });
      const script = bashPreserveOrReset({
        repoDir: clonePath,
        worktreeDir: worktreePath,
        branch,
        base: base ?? 'HEAD',
      });
      await runBashLocal(script, clonePath);
      effectivePath = worktreePath;
    } else {
      mkdirSync(worktreeParent, { recursive: true });
    }

    effectivePath = canonicalPathForComparison(effectivePath);
    active.add(effectivePath);
    this.activeWorktrees.set(repoUrl, active);

    const release = async () => {
      try {
        await this.execGit(['worktree', 'remove', '--force', effectivePath], clonePath);
      } catch {
        try { await this.execGit(['worktree', 'prune'], clonePath); } catch { /* best-effort */ }
      }
      active.delete(effectivePath);
    };

    const softRelease = () => { active.delete(effectivePath); };

    return { clonePath, worktreePath: effectivePath, branch, release, softRelease };
  }

  /** Get the deterministic clone directory path for a given repo URL. */
  getClonePath(repoUrl: string): string {
    return this.cloneDir(repoUrl);
  }

  async destroyAll(): Promise<void> {
    const releasePromises: Promise<void>[] = [];
    for (const [repoUrl, paths] of this.activeWorktrees) {
      const clonePath = this.cloneDir(repoUrl);
      for (const worktreePath of paths) {
        releasePromises.push(
          (async () => {
            try { await this.execGit(['worktree', 'remove', '--force', worktreePath], clonePath); } catch { /* */ }
          })(),
        );
      }
    }
    await Promise.allSettled(releasePromises);
    this.activeWorktrees.clear();
  }

  private execGit(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', (err) => {
        reject(new Error(`Failed to spawn git: ${err.message}`));
      });
      child.on('close', (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`git ${args.join(' ')} failed (code ${code}): ${stderr.trim()}`));
      });
    });
  }
}
