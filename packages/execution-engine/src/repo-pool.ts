import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { normalize } from 'node:path';
import { bashPreserveOrReset, runBashLocal } from './branch-utils.js';
import { RESTART_TO_BRANCH_TRACE, traceExecution } from './exec-trace.js';
import { createExecutionBench } from './execution-bench.js';
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

export interface RepoPoolTiming {
  mark(functionName: string, phase: 'started' | 'completed' | 'failed', metadata?: Record<string, unknown>): void;
  span<T>(functionName: string, metadata: Record<string, unknown> | undefined, fn: () => Promise<T>): Promise<T>;
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

interface RebaseRefreshBatch {
  baseBranches: Set<string>;
  syncedBaseBranches: Set<string>;
  callerCount: number;
  timings: RepoPoolTiming[];
  promise: Promise<string>;
  mirrorPath?: string;
  completedAtMs?: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

const REBASE_REFRESH_BATCH_WINDOW_MS = 25;
const REBASE_REFRESH_RECENT_REUSE_MS = 30_000;
const sharedCloneLocks = new Map<string, Promise<string>>();

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
  /** Chain of operations per repo to serialize git operations. */
  private repoChains = new Map<string, Promise<unknown>>();
  private pendingRebaseRefreshBatches = new Map<string, RebaseRefreshBatch>();

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
   * Force-fetch mirror and sync origin/<baseBranch> (rebase-and-retry).
   * Ignores remoteFetchForPool, while single-flighting same-repo retry storms.
   */
  async refreshMirrorForRebase(repoUrl: string, baseBranch: string, timing?: RepoPoolTiming): Promise<string> {
    const existingBatch = this.pendingRebaseRefreshBatches.get(repoUrl);
    if (existingBatch) {
      if (existingBatch.completedAtMs !== undefined && existingBatch.mirrorPath) {
        if (existingBatch.syncedBaseBranches.has(baseBranch)) {
          timing?.mark('RepoPool.refreshMirrorForRebase.recent', 'completed', {
            repoUrl,
            baseBranch,
            reuseAgeMs: Date.now() - existingBatch.completedAtMs,
          });
          return existingBatch.mirrorPath;
        }
        this.clearRebaseRefreshBatch(repoUrl, existingBatch);
      } else {
        if (existingBatch.cleanupTimer) {
          clearTimeout(existingBatch.cleanupTimer);
          existingBatch.cleanupTimer = undefined;
        }
        existingBatch.baseBranches.add(baseBranch);
        existingBatch.callerCount += 1;
        if (timing) existingBatch.timings.push(timing);
        return existingBatch.promise;
      }
    }

    const batch: RebaseRefreshBatch = {
      baseBranches: new Set([baseBranch]),
      syncedBaseBranches: new Set(),
      callerCount: 1,
      timings: timing ? [timing] : [],
      promise: Promise.resolve(''),
    };
    this.pendingRebaseRefreshBatches.set(repoUrl, batch);

    let releaseBatchWindow!: () => void;
    const batchWindow = new Promise<void>((resolve) => {
      releaseBatchWindow = resolve;
    });
    setTimeout(() => {
      releaseBatchWindow();
    }, REBASE_REFRESH_BATCH_WINDOW_MS);

    const prev = this.repoChains.get(repoUrl) ?? Promise.resolve();
    const queuedAtMs = Date.now();
    const next = prev.then(async () => {
      await batchWindow;
      const initialTimings = [...new Set(batch.timings)];
      for (const batchTiming of initialTimings) {
        batchTiming.mark('RepoPool.refreshMirrorForRebase.repoChainWait', 'completed', {
          repoUrl,
          durationMs: Date.now() - queuedAtMs,
        });
      }
      const dir = await this.doRefreshMirrorForRebaseBatch(repoUrl, batch, initialTimings[0]);
      const finalBaseBranches = [...batch.syncedBaseBranches];
      const finalTimings = [...new Set(batch.timings)];
      for (const batchTiming of finalTimings) {
        batchTiming.mark('RepoPool.refreshMirrorForRebase.batched', 'completed', {
          repoUrl,
          callerCount: batch.callerCount,
          baseBranchCount: finalBaseBranches.length,
        });
      }
      batch.mirrorPath = dir;
      batch.completedAtMs = Date.now();
      return dir;
    });
    this.repoChains.set(repoUrl, next.catch(() => {}));
    batch.promise = next.then(
      (dir) => {
        batch.cleanupTimer = setTimeout(() => {
          if (this.pendingRebaseRefreshBatches.get(repoUrl) === batch) {
            this.pendingRebaseRefreshBatches.delete(repoUrl);
          }
        }, REBASE_REFRESH_RECENT_REUSE_MS);
        return dir;
      },
      (err) => {
        this.clearRebaseRefreshBatch(repoUrl, batch);
        throw err;
      },
    );
    return batch.promise;
  }

  private clearRebaseRefreshBatch(repoUrl: string, batch: RebaseRefreshBatch): void {
    if (batch.cleanupTimer) {
      clearTimeout(batch.cleanupTimer);
      batch.cleanupTimer = undefined;
    }
    if (this.pendingRebaseRefreshBatches.get(repoUrl) === batch) {
      this.pendingRebaseRefreshBatches.delete(repoUrl);
    }
  }

  private async doRefreshMirrorForRebaseBatch(
    repoUrl: string,
    batch: RebaseRefreshBatch,
    timing?: RepoPoolTiming,
  ): Promise<string> {
    const dir = await this.refreshMirrorCloneForRebase(repoUrl, timing);
    const runGit = (args: string[]) => this.execGit(args, dir);
    while (true) {
      const baseBranches = [...batch.baseBranches].filter((branch) => !batch.syncedBaseBranches.has(branch));
      if (baseBranches.length === 0) {
        await Promise.resolve();
        const lateBaseBranches = [...batch.baseBranches].filter((branch) => !batch.syncedBaseBranches.has(branch));
        if (lateBaseBranches.length === 0) break;
        continue;
      }
      for (const branch of baseBranches) {
        await this.time(timing, 'RepoPool.doRefreshMirrorForRebase.syncPlanBaseRemoteForRef', { dir, baseBranch: branch }, () =>
          syncPlanBaseRemoteForRef(runGit, branch),
        );
        batch.syncedBaseBranches.add(branch);
      }
    }
    return dir;
  }

  private async refreshMirrorCloneForRebase(repoUrl: string, timing?: RepoPoolTiming): Promise<string> {
    const dir = this.cloneDir(repoUrl);
    if (existsSync(dir)) {
      try {
        await this.time(timing, 'RepoPool.doRefreshMirrorForRebase.gitFetchAllPrune', { dir }, () =>
          this.execGit(['fetch', '--all', '--prune'], dir),
        );
      } catch (err) {
        console.warn(`[RepoPool] refreshMirrorForRebase fetch failed: ${err}`);
      }
      try {
        const branch = (await this.time(timing, 'RepoPool.doRefreshMirrorForRebase.gitCurrentBranch', { dir }, () =>
          this.execGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir),
        )).trim();
        if (branch !== 'HEAD') {
          await this.time(timing, 'RepoPool.doRefreshMirrorForRebase.gitFastForwardCurrentBranch', { dir, branch }, () =>
            this.execGit(['merge', '--ff-only', `origin/${branch}`], dir),
          );
        } else {
          timing?.mark('RepoPool.doRefreshMirrorForRebase.gitFastForwardCurrentBranch', 'completed', {
            dir,
            branch,
            skipped: true,
            reason: 'detached-head',
          });
        }
      } catch { /* non-ff or detached */ }
    } else {
      mkdirSync(this.cacheDir, { recursive: true });
      await this.time(timing, 'RepoPool.doRefreshMirrorForRebase.gitCloneMirror', { dir, repoUrl }, () =>
        this.execGit(['clone', repoUrl, dir], this.cacheDir),
      );
    }
    return dir;
  }

  /**
   * Remove Invoker-managed branches (experiment/*, invoker/*) from the mirror and linked worktrees.
   */
  async removeManagedBranchesInMirror(repoUrl: string, branches: string[], timing?: RepoPoolTiming): Promise<void> {
    if (branches.length === 0) {
      timing?.mark('RepoPool.removeManagedBranchesInMirror', 'completed', {
        repoUrl,
        enabled: isWorkspaceCleanupEnabled(),
        skipped: true,
        reason: 'no-branches',
        branchCount: 0,
      });
      return;
    }
    if (!isWorkspaceCleanupEnabled()) {
      timing?.mark('RepoPool.removeManagedBranchesInMirror', 'completed', {
        repoUrl,
        enabled: false,
        skipped: true,
        reason: 'disabled',
        branchCount: branches.length,
      });
      return;
    }
    const prev = this.repoChains.get(repoUrl) ?? Promise.resolve();
    const queuedAtMs = Date.now();
    const next = prev.then(() => {
      timing?.mark('RepoPool.removeManagedBranchesInMirror.repoChainWait', 'completed', {
        repoUrl,
        branchCount: branches.length,
        durationMs: Date.now() - queuedAtMs,
      });
      return this.doRemoveManagedBranchesInMirror(repoUrl, branches, timing);
    });
    this.repoChains.set(repoUrl, next.catch(() => {}));
    return next;
  }

  private async doRemoveManagedBranchesInMirror(repoUrl: string, branches: string[], timing?: RepoPoolTiming): Promise<void> {
    const dir = this.cloneDir(repoUrl);
    if (!existsSync(dir) || !this.worktreeBaseDir) {
      timing?.mark('RepoPool.doRemoveManagedBranchesInMirror', 'completed', {
        enabled: true,
        skipped: true,
        reason: 'missing-dir-or-worktree-base',
        branchCount: branches.length,
      });
      return;
    }
    for (const branch of branches) {
      if (!isInvokerManagedPoolBranch(branch)) continue;
      const sanitized = sanitizeBranchForPath(branch);
      const wtPath = `${this.worktreeBaseDir}/${computeRepoUrlHash(repoUrl)}/${sanitized}`;
      try {
        await this.time(timing, 'RepoPool.doRemoveManagedBranchesInMirror.gitWorktreeRemove', { dir, branch, wtPath }, () =>
          this.execGit(['worktree', 'remove', '--force', wtPath], dir),
        );
      } catch {
        /* not registered */
      }
      if (existsSync(wtPath)) {
        try {
          rmSync(wtPath, { recursive: true, force: true });
        } catch { /* */ }
      }
      try {
        await this.time(timing, 'RepoPool.doRemoveManagedBranchesInMirror.gitBranchDelete', { dir, branch }, () =>
          this.execGit(['branch', '-D', branch], dir),
        );
      } catch {
        /* missing or checked out elsewhere */
      }
    }
  }

  private async time<T>(
    timing: RepoPoolTiming | undefined,
    functionName: string,
    metadata: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!timing) return fn();
    return timing.span(functionName, metadata, fn);
  }

  async ensureClone(repoUrl: string): Promise<string> {
    const bench = createExecutionBench({
      module: 'repo-pool-bench',
      baseMetadata: { repoUrl },
    });
    bench('RepoPool.ensureClone.begin');
    // Serialize clone/fetch operations per clone path across RepoPool instances.
    const clonePath = this.cloneDir(repoUrl);
    const existing = sharedCloneLocks.get(clonePath);
    if (existing) {
      bench('RepoPool.ensureClone.waitForExistingLock.before');
      const lockedClonePath = await existing;
      bench('RepoPool.ensureClone.waitForExistingLock.after', { clonePath: lockedClonePath });
      return lockedClonePath;
    }

    const promise = this.doEnsureClone(repoUrl);
    sharedCloneLocks.set(clonePath, promise);
    try {
      const ensuredClonePath = await promise;
      bench('RepoPool.ensureClone.after', { clonePath: ensuredClonePath });
      return ensuredClonePath;
    } finally {
      sharedCloneLocks.delete(clonePath);
      bench('RepoPool.ensureClone.lockDeleted');
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

  private isAlreadyExistsWorktreeError(err: unknown, worktreePath: string): boolean {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('already exists')) return false;
    if (message.includes(worktreePath)) return true;
    const normalizedPath = canonicalPathForComparison(worktreePath);
    return message.includes(normalizedPath);
  }

  private async runPreserveOrResetWithRecovery(
    clonePath: string,
    worktreePath: string,
    branch: string,
    base: string,
  ): Promise<void> {
    const bench = createExecutionBench({
      module: 'repo-pool-bench',
      baseMetadata: { branch, base, clonePath, worktreePath },
    });
    bench('RepoPool.runPreserveOrResetWithRecovery.begin');
    const script = bashPreserveOrReset({
      repoDir: clonePath,
      worktreeDir: worktreePath,
      branch,
      base,
    });
    try {
      bench('RepoPool.runPreserveOrResetWithRecovery.runBashLocal.before');
      await runBashLocal(script, clonePath);
      bench('RepoPool.runPreserveOrResetWithRecovery.runBashLocal.after');
      return;
    } catch (err) {
      if (!this.isAlreadyExistsWorktreeError(err, worktreePath)) {
        bench('RepoPool.runPreserveOrResetWithRecovery.runBashLocal.failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      traceExecution(
        `[RepoPool] runPreserveOrResetWithRecovery: retrying after pre-existing path branch=${branch} path=${worktreePath}`,
      );
      bench('RepoPool.runPreserveOrResetWithRecovery.reconcileStaleWorktreePath.before');
      await this.reconcileStaleWorktreePath(clonePath, worktreePath);
      bench('RepoPool.runPreserveOrResetWithRecovery.reconcileStaleWorktreePath.after');
    }
    bench('RepoPool.runPreserveOrResetWithRecovery.retryRunBashLocal.before');
    await runBashLocal(script, clonePath);
    bench('RepoPool.runPreserveOrResetWithRecovery.retryRunBashLocal.after');
  }

  private async doEnsureClone(repoUrl: string): Promise<string> {
    const bench = createExecutionBench({
      module: 'repo-pool-bench',
      baseMetadata: { repoUrl },
    });
    const dir = this.cloneDir(repoUrl);
    bench('RepoPool.doEnsureClone.begin', { dir, exists: existsSync(dir) });
    if (existsSync(dir)) {
      if (remoteFetchForPool.enabled) {
        try {
          bench('RepoPool.doEnsureClone.gitFetchAllPrune.before', { dir });
          await this.execGit(['fetch', '--all', '--prune'], dir);
          bench('RepoPool.doEnsureClone.gitFetchAllPrune.after', { dir });
        } catch (err) {
          console.warn(`[RepoPool] doEnsureClone fetch failed: ${err}`);
          bench('RepoPool.doEnsureClone.gitFetchAllPrune.failed', {
            dir,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        // Advance local HEAD branch to match origin so rev-parse returns the fresh ref
        try {
          bench('RepoPool.doEnsureClone.gitCurrentBranch.before', { dir });
          const branch = (await this.execGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir)).trim();
          bench('RepoPool.doEnsureClone.gitCurrentBranch.after', { dir, branch });
          if (branch !== 'HEAD') {
            bench('RepoPool.doEnsureClone.gitFastForwardCurrentBranch.before', { dir, branch });
            await this.execGit(['merge', '--ff-only', `origin/${branch}`], dir);
            bench('RepoPool.doEnsureClone.gitFastForwardCurrentBranch.after', { dir, branch });
          } else {
            bench('RepoPool.doEnsureClone.gitFastForwardCurrentBranch.skipped', { dir, branch });
          }
        } catch (err) {
          bench('RepoPool.doEnsureClone.gitFastForwardCurrentBranch.failed', {
            dir,
            error: err instanceof Error ? err.message : String(err),
          });
          /* non-ff or detached; leave as-is */
        }
      }
      bench('RepoPool.doEnsureClone.returnExisting', { dir });
      return dir;
    }
    mkdirSync(this.cacheDir, { recursive: true });
    bench('RepoPool.doEnsureClone.gitClone.before', { dir });
    await this.execGit(['clone', repoUrl, dir], this.cacheDir);
    bench('RepoPool.doEnsureClone.gitClone.after', { dir });
    return dir;
  }

  async acquireWorktree(
    repoUrl: string,
    branch: string,
    base?: string,
    actionId?: string,
    opts?: AcquireWorktreeOptions,
  ): Promise<AcquiredWorktree> {
    const bench = createExecutionBench({
      module: 'repo-pool-bench',
      baseMetadata: { repoUrl, branch, base, actionId },
    });
    bench('RepoPool.acquireWorktree.begin');
    // Serialize per-repo to prevent concurrent git worktree operations
    const prev = this.repoChains.get(repoUrl) ?? Promise.resolve();
    const queuedAtMs = Date.now();
    const next = prev.then(() => {
      bench('RepoPool.acquireWorktree.repoChainWait.after', { durationMs: Date.now() - queuedAtMs });
      return this.doAcquireWorktree(repoUrl, branch, base, actionId, opts);
    });
    this.repoChains.set(repoUrl, next.catch(() => {}));
    const acquired = await next;
    bench('RepoPool.acquireWorktree.after', { worktreePath: acquired.worktreePath });
    return acquired;
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
    const bench = createExecutionBench({
      module: 'repo-pool-bench',
      baseMetadata: { repoUrl, branch, base, actionId, forceFresh: opts?.forceFresh === true },
    });
    bench('RepoPool.doAcquireWorktree.begin');
    traceExecution(
      `${RESTART_TO_BRANCH_TRACE} RepoPool.doAcquireWorktree branch=${branch} (bashPreserveOrReset here; BaseExecutor.setupTaskBranch is not used for this path)`,
    );
    bench('RepoPool.doAcquireWorktree.ensureClone.before');
    const clonePath = await this.ensureClone(repoUrl);
    bench('RepoPool.doAcquireWorktree.ensureClone.after', { clonePath });
    const active = this.activeWorktrees.get(repoUrl) ?? new Set();
    bench('RepoPool.doAcquireWorktree.activeWorktreeCount', { activeCount: active.size, maxWorktrees: this.maxWorktrees });
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
      bench('RepoPool.doAcquireWorktree.gitWorktreeList.before', { clonePath });
      porcelain = await this.execGit(['worktree', 'list', '--porcelain'], clonePath);
      bench('RepoPool.doAcquireWorktree.gitWorktreeList.after', { clonePath });
    } catch {
      porcelain = '';
      bench('RepoPool.doAcquireWorktree.gitWorktreeList.failed', { clonePath });
    }

    const allowReuse = opts?.forceFresh !== true;
    bench('RepoPool.doAcquireWorktree.findReuseCandidates.before', { allowReuse });
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
    bench('RepoPool.doAcquireWorktree.findReuseCandidates.after', {
      hasReuseCandidate: !!reuseCandidate,
      hasExactBranchCandidate: !!exactBranchCandidate,
      hasActionIdCandidate: !!actionIdCandidate,
      hasContentCandidate: !!contentCandidate,
    });

    bench('RepoPool.doAcquireWorktree.planManagedWorktree.before');
    let plan = planManagedWorktree({
      targetBranch: branch,
      targetWorktreePath: worktreePath,
      forceFresh: opts?.forceFresh,
      exactBranchCandidate,
      actionIdCandidate,
      contentCandidate,
    });
    bench('RepoPool.doAcquireWorktree.planManagedWorktree.after', { planKind: plan.kind });

    if (plan.kind === 'reuse_exact') {
      bench('RepoPool.doAcquireWorktree.isReusableManagedWorktree.before', {
        planKind: plan.kind,
        worktreePath: plan.worktreePath,
      });
      const reusable = await this.isReusableManagedWorktree(plan.worktreePath, branch);
      bench('RepoPool.doAcquireWorktree.isReusableManagedWorktree.after', {
        planKind: plan.kind,
        worktreePath: plan.worktreePath,
        reusable,
      });
      if (!reusable) {
        plan = {
          kind: 'recreate',
          worktreePath,
          cleanupPaths: [worktreePath, plan.worktreePath],
        };
      }
    } else if (plan.kind === 'rename_reuse' || plan.kind === 'rename_to_lifecycle') {
      bench('RepoPool.doAcquireWorktree.isReusableManagedWorktree.before', {
        planKind: plan.kind,
        worktreePath: plan.worktreePath,
      });
      const reusable = await this.isReusableManagedWorktree(plan.worktreePath, plan.fromBranch);
      bench('RepoPool.doAcquireWorktree.isReusableManagedWorktree.after', {
        planKind: plan.kind,
        worktreePath: plan.worktreePath,
        reusable,
      });
      if (!reusable) {
        plan = {
          kind: 'recreate',
          worktreePath,
          cleanupPaths: [worktreePath, plan.worktreePath],
        };
      }
    }

    let effectivePath = worktreePath;
    bench('RepoPool.doAcquireWorktree.applyPlan.before', { planKind: plan.kind });
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
          await this.runPreserveOrResetWithRecovery(
            clonePath,
            worktreePath,
            branch,
            base ?? 'HEAD',
          );
          bench('RepoPool.doAcquireWorktree.renameFallbackPreserveOrReset.after', { worktreePath });
          effectivePath = worktreePath;
        }
        break;
      case 'recreate':
        bench('RepoPool.doAcquireWorktree.reconcileLeakedTargetPath.before', { worktreePath });
        await this.reconcileLeakedTargetPath(clonePath, worktreePath, porcelain, branch);
        bench('RepoPool.doAcquireWorktree.reconcileLeakedTargetPath.after', { worktreePath });
        if (isWorkspaceCleanupEnabled()) {
          for (const cleanupPath of plan.cleanupPaths) {
            bench('RepoPool.doAcquireWorktree.reconcileStaleWorktreePath.before', { cleanupPath });
            await this.reconcileStaleWorktreePath(clonePath, cleanupPath);
            bench('RepoPool.doAcquireWorktree.reconcileStaleWorktreePath.after', { cleanupPath });
          }
        }
        mkdirSync(worktreeParent, { recursive: true });
        bench('RepoPool.doAcquireWorktree.runPreserveOrResetWithRecovery.before', { worktreePath });
        await this.runPreserveOrResetWithRecovery(
          clonePath,
          worktreePath,
          branch,
          base ?? 'HEAD',
        );
        bench('RepoPool.doAcquireWorktree.runPreserveOrResetWithRecovery.after', { worktreePath });
        effectivePath = worktreePath;
        break;
    }

    effectivePath = canonicalPathForComparison(effectivePath);
    active.add(effectivePath);
    this.activeWorktrees.set(repoUrl, active);
    bench('RepoPool.doAcquireWorktree.applyPlan.after', {
      planKind: plan.kind,
      effectivePath,
      activeCount: active.size,
    });

    const release = async () => {
      try {
        await this.execGit(['worktree', 'remove', '--force', effectivePath], clonePath);
      } catch {
        try { await this.execGit(['worktree', 'prune'], clonePath); } catch { /* best-effort */ }
      }
      active.delete(effectivePath);
    };

    const softRelease = () => { active.delete(effectivePath); };

    bench('RepoPool.doAcquireWorktree.returning', { effectivePath });
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
