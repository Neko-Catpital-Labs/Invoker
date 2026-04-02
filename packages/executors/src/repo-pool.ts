import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { normalize } from 'node:path';
import { bashPreserveOrReset, runBashLocal } from './branch-utils.js';
import { RESTART_TO_BRANCH_TRACE } from './exec-trace.js';
import { findManagedWorktreeForBranch, abbrevRefMatchesBranch } from './worktree-discovery.js';
import { syncPlanBaseRemote, isInvokerManagedPoolBranch } from './plan-base-remote.js';
import { remoteFetchForPool } from './remote-fetch-policy.js';

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

  private urlHash(repoUrl: string): string {
    return createHash('sha256').update(repoUrl).digest('hex').slice(0, 12);
  }

  private cloneDir(repoUrl: string): string {
    return `${this.cacheDir}/${this.urlHash(repoUrl)}`;
  }

  /** Deterministic external worktree path for a branch (requires worktreeBaseDir). */
  externalWorktreePath(repoUrl: string, branch: string): string {
    if (!this.worktreeBaseDir) {
      throw new Error('RepoPool.externalWorktreePath requires worktreeBaseDir');
    }
    const sanitized = branch.replace(/\//g, '-');
    return `${this.worktreeBaseDir}/${this.urlHash(repoUrl)}/${sanitized}`;
  }

  /**
   * Force-fetch mirror and sync origin/<baseBranch> (rebase-and-retry). Ignores remoteFetchForPool.
   */
  async refreshMirrorForRebase(repoUrl: string, baseBranch: string): Promise<string> {
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
    await syncPlanBaseRemote(runGit, baseBranch);
    return dir;
  }

  /**
   * Remove Invoker-managed branches (experiment/*, invoker/*) from the mirror and linked worktrees.
   */
  async removeManagedBranchesInMirror(repoUrl: string, branches: string[]): Promise<void> {
    const dir = this.cloneDir(repoUrl);
    if (!existsSync(dir) || !this.worktreeBaseDir) return;
    for (const branch of branches) {
      if (!isInvokerManagedPoolBranch(branch)) continue;
      const sanitized = branch.replace(/\//g, '-');
      const wtPath = `${this.worktreeBaseDir}/${this.urlHash(repoUrl)}/${sanitized}`;
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

  async acquireWorktree(repoUrl: string, branch: string, base?: string): Promise<AcquiredWorktree> {
    // Serialize per-repo to prevent concurrent git worktree operations
    const prev = this.repoChains.get(repoUrl) ?? Promise.resolve();
    const next = prev.then(() => this.doAcquireWorktree(repoUrl, branch, base));
    this.repoChains.set(repoUrl, next.catch(() => {}));
    return next;
  }

  private async doAcquireWorktree(repoUrl: string, branch: string, base?: string): Promise<AcquiredWorktree> {
    console.log(
      `${RESTART_TO_BRANCH_TRACE} RepoPool.doAcquireWorktree branch=${branch} (bashPreserveOrReset here; BaseFamiliar.setupTaskBranch is not used for this path)`,
    );
    const clonePath = await this.ensureClone(repoUrl);
    const active = this.activeWorktrees.get(repoUrl) ?? new Set();
    if (active.size >= this.maxWorktrees) {
      throw new ResourceLimitError(`Worktree limit reached for ${repoUrl}: ${active.size}/${this.maxWorktrees}`);
    }
    const sanitized = branch.replace(/\//g, '-');
    const worktreePath = this.worktreeBaseDir
      ? `${this.worktreeBaseDir}/${this.urlHash(repoUrl)}/${sanitized}`
      : `${clonePath}/worktrees/${sanitized}`;
    const worktreeParent = worktreePath.substring(0, worktreePath.lastIndexOf('/'));
    const managedPrefixes = [
      normalize(
        this.worktreeBaseDir
          ? `${this.worktreeBaseDir}/${this.urlHash(repoUrl)}`
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
          console.log(
            `${RESTART_TO_BRANCH_TRACE} RepoPool.doAcquireWorktree reuse existing worktree path=${effectivePath} branch=${branch}`,
          );
        }
      } catch {
        /* fall through to create */
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
