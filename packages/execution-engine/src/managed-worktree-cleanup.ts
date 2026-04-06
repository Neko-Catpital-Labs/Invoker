import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

export interface CleanupManagedWorktreesResult {
  removed: string[];
  errors: string[];
}

function execGit(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`));
    });
  });
}

/**
 * Remove all Invoker-managed linked worktrees under `worktreeBaseDir` and embedded
 * `repos/<hash>/worktrees/*`, using `git worktree remove --force` from each main clone.
 * Does not delete bare clone caches in `cacheDir`.
 */
export async function cleanupManagedWorktrees(opts: {
  cacheDir: string;
  worktreeBaseDir: string;
}): Promise<CleanupManagedWorktreesResult> {
  console.log(`[cleanup] cleanupManagedWorktrees() called — cacheDir=${opts.cacheDir} worktreeBaseDir=${opts.worktreeBaseDir}`);
  const removed: string[] = [];
  const errors: string[] = [];

  if (existsSync(opts.worktreeBaseDir)) {
    console.log(`[cleanup] scanning worktreeBaseDir: ${opts.worktreeBaseDir}`);
    for (const urlHash of readdirSync(opts.worktreeBaseDir)) {
      const clonePath = join(opts.cacheDir, urlHash);
      const wtRoot = join(opts.worktreeBaseDir, urlHash);
      if (!statSync(wtRoot).isDirectory()) continue;
      if (!existsSync(clonePath)) {
        errors.push(`No clone at ${clonePath} for worktrees under ${wtRoot} (skipping)`);
        continue;
      }
      for (const name of readdirSync(wtRoot)) {
        const wtPath = join(wtRoot, name);
        if (!statSync(wtPath).isDirectory()) continue;
        console.log(`[cleanup] removing external worktree: ${wtPath} (git worktree remove --force from ${clonePath})`);
        try {
          await execGit(['worktree', 'remove', '--force', wtPath], clonePath);
          console.log(`[cleanup] removed worktree: ${wtPath}`);
          removed.push(wtPath);
        } catch (e) {
          console.warn(`[cleanup] failed to remove worktree ${wtPath}: ${e instanceof Error ? e.message : String(e)}`);
          errors.push(`${wtPath}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  } else {
    console.log(`[cleanup] worktreeBaseDir does not exist: ${opts.worktreeBaseDir}`);
  }

  if (existsSync(opts.cacheDir)) {
    console.log(`[cleanup] scanning cacheDir for embedded worktrees: ${opts.cacheDir}`);
    for (const urlHash of readdirSync(opts.cacheDir)) {
      const clonePath = join(opts.cacheDir, urlHash);
      if (!statSync(clonePath).isDirectory()) continue;
      const embedded = join(clonePath, 'worktrees');
      if (!existsSync(embedded) || !statSync(embedded).isDirectory()) continue;
      for (const name of readdirSync(embedded)) {
        const wtPath = join(embedded, name);
        if (!statSync(wtPath).isDirectory()) continue;
        console.log(`[cleanup] removing embedded worktree: ${wtPath} (from ${clonePath})`);
        try {
          await execGit(['worktree', 'remove', '--force', wtPath], clonePath);
          console.log(`[cleanup] removed embedded worktree: ${wtPath}`);
          removed.push(wtPath);
        } catch (e) {
          console.warn(`[cleanup] failed to remove embedded worktree ${wtPath}: ${e instanceof Error ? e.message : String(e)}`);
          errors.push(`${wtPath}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  console.log(`[cleanup] cleanupManagedWorktrees() done — removed=${removed.length} errors=${errors.length}`);
  return { removed, errors };
}
