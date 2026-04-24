import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { normalize } from 'node:path';
import { bashPreserveOrReset, runBashLocal } from './branch-utils.js';
import { RESTART_TO_BRANCH_TRACE, traceExecution } from './exec-trace.js';
import { planManagedWorktree } from './managed-worktree-controller.js';
import {
  abbrevRefMatchesBranch,
  canonicalPathForComparison,
  findContentHashCollisions,
  findManagedWorktreeByActionId,
  findManagedWorktreeByContent,
  findManagedWorktreeForBranch,
  parseGitWorktreePorcelain,
  parseExperimentBranch,
} from './worktree-discovery.js';
import { syncPlanBaseRemoteForRef, isInvokerManagedPoolBranch } from './plan-base-remote.js';
import { remoteFetchForPool } from './remote-fetch-policy.js';
import { isWorkspaceCleanupEnabled } from './workspace-cleanup-policy.js';
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

export interface AcquireWorktreeOptions {
  forceFresh?: boolean;
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
  async refreshMirrorForRebase(repoUrl: string, baseBranch: string): Promise<string> {
    const prev = this.repoChains.get(repoUrl) ?? Promise.resolve();
    const next = prev.then(() => this.doRefreshMirrorForRebase(repoUrl, baseBranch));
    this.repoChains.set(repoUrl, next.catch(() => {}));
    return next;
  }

  private async doRefreshMirrorForRebase(repoUrl: string, baseBranch: string): Promise<string> {
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
    await syncPlanBaseRemoteForRef(runGit, baseBranch);
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
    // Gated: with attemptId in branch hash, leftover refs cannot collide with
    // future attempts, so deletion is unnecessary. Set
    // INVOKER_ENABLE_WORKSPACE_CLEANUP=1 to restore the rebase-and-retry
    // branch sweep.
    if (!isWorkspaceCleanupEnabled()) return;
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

  private isPathRegisteredInPorcelain(porcelain: string, worktreePath: string): boolean {
    const target = canonicalPathForComparison(worktreePath);
    return parseGitWorktreePorcelain(porcelain).some((entry) => canonicalPathForComparison(entry.path) === target);
  }

  private async reconcileLeakedTargetPath(
    clonePath: string,
    worktreePath: string,
    porcelain: string,
    branch: string,
  ): Promise<void> {
    if (!existsSync(worktreePath)) return;
    const registered = this.isPathRegisteredInPorcelain(porcelain, worktreePath);
    traceExecution(
      `[RepoPool] reconcileLeakedTargetPath branch=${branch} path=${worktreePath} exists=true registered=${registered}`,
    );
    if (registered) {
      await this.reconcileStaleWorktreePath(clonePath, worktreePath);
      return;
    }
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch {
      /* best-effort; bashPreserveOrReset will surface failure */
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

  async acquireWorktree(
    repoUrl: string,
    branch: string,
    base?: string,
    actionId?: string,
    opts?: AcquireWorktreeOptions,
  ): Promise<AcquiredWorktree> {
    // Serialize per-repo to prevent concurrent git worktree operations
    const prev = this.repoChains.get(repoUrl) ?? Promise.resolve();
    const next = prev.then(() => this.doAcquireWorktree(repoUrl, branch, base, actionId, opts));
    this.repoChains.set(repoUrl, next.catch(() => {}));
    return next;
  }

  /**
   * Reconcile the in-memory active worktree set with externally known live paths.
   *
   * The pool's active set is only an in-memory throttle; the executor is the
   * authority on which worktree paths are actually still live in this process.
   * Under heavy churn, early terminal paths can otherwise leave stale slot
   * reservations behind and artificially pin the pool at max capacity.
   */
  reconcileActiveWorktrees(repoUrl: string, livePaths: Iterable<string>): void {
    const live = new Set(Array.from(livePaths, (path) => canonicalPathForComparison(path)));
    if (live.size === 0) {
      this.activeWorktrees.delete(repoUrl);
      return;
    }
    this.activeWorktrees.set(repoUrl, live);
  }

  private async isReusableManagedWorktree(worktreePath: string, expectedBranch: string): Promise<boolean> {
    try {
      const head = (await this.execGit(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath)).trim();
      if (!abbrevRefMatchesBranch(head, expectedBranch)) return false;
      await this.execGit(['status', '--porcelain'], worktreePath);
      return true;
    } catch {
      return false;
    }
  }

  private async doAcquireWorktree(
    repoUrl: string,
    branch: string,
    base?: string,
    actionId?: string,
    opts?: AcquireWorktreeOptions,
  ): Promise<AcquiredWorktree> {
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

    const allowReuse = opts?.forceFresh !== true;
    const reuseCandidate = allowReuse ? findManagedWorktreeForBranch(porcelain, branch, managedPrefixes) : undefined;
    let exactBranchCandidate: { path: string; headMatchesTargetBranch: boolean } | undefined;
    if (reuseCandidate && existsSync(reuseCandidate)) {
      try {
        const head = (await this.execGit(['rev-parse', '--abbrev-ref', 'HEAD'], reuseCandidate)).trim();
        exactBranchCandidate = {
          path: reuseCandidate,
          headMatchesTargetBranch: abbrevRefMatchesBranch(head, branch),
        };
      } catch {
        exactBranchCandidate = undefined;
      }
    }

    let actionIdCandidate:
      | { path: string; branch: string; baseIsAncestorOfHead: boolean }
      | undefined;
    if (allowReuse && actionId) {
      const actionIdHit = findManagedWorktreeByActionId(porcelain, actionId, managedPrefixes);
      if (actionIdHit && existsSync(actionIdHit.path)) {
        let baseIsAncestorOfHead = true;
        if (base) {
          try {
            await this.execGit(['merge-base', '--is-ancestor', base, 'HEAD'], actionIdHit.path);
          } catch {
            baseIsAncestorOfHead = false;
          }
        }
        actionIdCandidate = {
          path: actionIdHit.path,
          branch: actionIdHit.branch,
          baseIsAncestorOfHead,
        };
      }
    }

    // Cache-equivalent reuse: same actionId + content hash, different lifecycle
    // tag. This remains available for non-fresh flows only; recreate-style
    // flows must allocate a fresh workspace path as well as a fresh branch.
    let contentCandidate: { path: string; branch: string } | undefined;
    const parsedTargetBranch = parseExperimentBranch(branch);
    if (parsedTargetBranch) {
      const contentHit = findManagedWorktreeByContent(
        porcelain,
        parsedTargetBranch.actionId,
        parsedTargetBranch.contentHash,
        managedPrefixes,
      );
      if (contentHit && existsSync(contentHit.path) && contentHit.branch !== branch) {
        contentCandidate = { path: contentHit.path, branch: contentHit.branch };
      }

      // Cross-actionId hash collisions are observable but not actionable here
      // because the actionId/lifecycle parts of the branch still disambiguate.
      const collisions = findContentHashCollisions(
        porcelain,
        parsedTargetBranch.contentHash,
        parsedTargetBranch.actionId,
        managedPrefixes,
      );
      if (collisions.length > 0) {
        const summary = collisions
          .map((c) => `${c.branch} @ ${c.path}`)
          .join('; ');
        traceExecution(
          `[branch-hash-collision] contentHash=${parsedTargetBranch.contentHash} target=${branch} collides with: ${summary}`,
        );
      }
    }

    let plan = planManagedWorktree({
      targetBranch: branch,
      targetWorktreePath: worktreePath,
      forceFresh: opts?.forceFresh,
      exactBranchCandidate,
      actionIdCandidate,
      contentCandidate,
    });

    if (plan.kind === 'reuse_exact') {
      const reusable = await this.isReusableManagedWorktree(plan.worktreePath, branch);
      if (!reusable) {
        plan = {
          kind: 'recreate',
          worktreePath,
          cleanupPaths: [worktreePath, plan.worktreePath],
        };
      }
    } else if (plan.kind === 'rename_reuse' || plan.kind === 'rename_to_lifecycle') {
      const reusable = await this.isReusableManagedWorktree(plan.worktreePath, plan.fromBranch);
      if (!reusable) {
        plan = {
          kind: 'recreate',
          worktreePath,
          cleanupPaths: [worktreePath, plan.worktreePath],
        };
      }
    }

    let effectivePath = worktreePath;
    switch (plan.kind) {
      case 'reuse_exact':
        effectivePath = plan.worktreePath;
        traceExecution(
          `${RESTART_TO_BRANCH_TRACE} RepoPool.doAcquireWorktree reuse existing worktree path=${effectivePath} branch=${branch}`,
        );
        mkdirSync(worktreeParent, { recursive: true });
        break;
      case 'rename_reuse':
      case 'rename_to_lifecycle':
        try {
          await this.execGit(['branch', '-m', plan.fromBranch, plan.toBranch], plan.worktreePath);
          const head = (await this.execGit(['rev-parse', '--abbrev-ref', 'HEAD'], plan.worktreePath)).trim();
          if (!abbrevRefMatchesBranch(head, plan.toBranch)) {
            throw new Error(`renamed worktree HEAD mismatch: ${head}`);
          }
          effectivePath = plan.worktreePath;
          traceExecution(
            `${RESTART_TO_BRANCH_TRACE} RepoPool.doAcquireWorktree ${plan.kind}: renamed ${plan.fromBranch} → ${plan.toBranch} path=${effectivePath}`,
          );
          mkdirSync(worktreeParent, { recursive: true });
        } catch {
          await this.reconcileLeakedTargetPath(clonePath, worktreePath, porcelain, branch);
          mkdirSync(worktreeParent, { recursive: true });
          const script = bashPreserveOrReset({
            repoDir: clonePath,
            worktreeDir: worktreePath,
            branch,
            base: base ?? 'HEAD',
          });
          await runBashLocal(script, clonePath);
          effectivePath = worktreePath;
        }
        break;
      case 'recreate':
        await this.reconcileLeakedTargetPath(clonePath, worktreePath, porcelain, branch);
        if (isWorkspaceCleanupEnabled()) {
          for (const cleanupPath of plan.cleanupPaths) {
            await this.reconcileStaleWorktreePath(clonePath, cleanupPath);
          }
        }
        mkdirSync(worktreeParent, { recursive: true });
        {
          const script = bashPreserveOrReset({
            repoDir: clonePath,
            worktreeDir: worktreePath,
            branch,
            base: base ?? 'HEAD',
          });
          await runBashLocal(script, clonePath);
        }
        effectivePath = worktreePath;
        break;
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
