import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';

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

  private async doEnsureClone(repoUrl: string): Promise<string> {
    const dir = this.cloneDir(repoUrl);
    if (existsSync(dir)) {
      await this.execGit(['fetch', '--all'], dir);
      return dir;
    }
    mkdirSync(this.cacheDir, { recursive: true });
    await this.execGit(['clone', repoUrl, dir], this.cacheDir);
    return dir;
  }

  async acquireWorktree(repoUrl: string, branch: string): Promise<AcquiredWorktree> {
    // Serialize per-repo to prevent concurrent git worktree operations
    const prev = this.repoChains.get(repoUrl) ?? Promise.resolve();
    const next = prev.then(() => this.doAcquireWorktree(repoUrl, branch));
    this.repoChains.set(repoUrl, next.catch(() => {}));
    return next;
  }

  private async doAcquireWorktree(repoUrl: string, branch: string): Promise<AcquiredWorktree> {
    const clonePath = await this.ensureClone(repoUrl);
    const active = this.activeWorktrees.get(repoUrl) ?? new Set();
    if (active.size >= this.maxWorktrees) {
      throw new Error(`Worktree limit reached for ${repoUrl}: ${active.size}/${this.maxWorktrees}`);
    }
    const sanitized = branch.replace(/\//g, '-');
    const worktreePath = this.worktreeBaseDir
      ? `${this.worktreeBaseDir}/${this.urlHash(repoUrl)}/${sanitized}`
      : `${clonePath}/worktrees/${sanitized}`;
    const worktreeParent = worktreePath.substring(0, worktreePath.lastIndexOf('/'));
    mkdirSync(worktreeParent, { recursive: true });
    // Preserve cherry-picks: if branch has commits ahead of HEAD, reuse it
    let preserved = false;
    try {
      await this.execGit(['rev-parse', '--verify', branch], clonePath);
      const cloneHead = (await this.execGit(['rev-parse', 'HEAD'], clonePath)).trim();
      const aheadCount = (await this.execGit(
        ['rev-list', '--count', `${cloneHead}..${branch}`], clonePath,
      )).trim();
      if (parseInt(aheadCount, 10) > 0) {
        await this.execGit(['worktree', 'add', worktreePath, branch], clonePath);
        await this.execGit(['merge', '--no-edit', cloneHead], worktreePath);
        preserved = true;
      }
    } catch {
      // Branch doesn't exist or check failed — force-create
    }
    if (!preserved) {
      await this.execGit(['worktree', 'add', '-B', branch, worktreePath], clonePath);
    }
    active.add(worktreePath);
    this.activeWorktrees.set(repoUrl, active);

    const release = async () => {
      try {
        await this.execGit(['worktree', 'remove', '--force', worktreePath], clonePath);
      } catch {
        try { await this.execGit(['worktree', 'prune'], clonePath); } catch { /* best-effort */ }
      }
      active.delete(worktreePath);
    };

    return { clonePath, worktreePath, branch, release };
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
