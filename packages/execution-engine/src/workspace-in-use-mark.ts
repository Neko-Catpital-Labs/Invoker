import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const IN_USE_MARK_DIR = 'in-use';
export const IN_USE_MARK_MAX_AGE_SECONDS = 900;

export function inUseMarkRelativePath(workspaceRelativeToHome: string): string {
  if (!workspaceRelativeToHome.startsWith('worktrees/')) {
    throw new Error(`In-use mark workspace path must start with worktrees/: ${workspaceRelativeToHome}`);
  }
  return `${IN_USE_MARK_DIR}/${workspaceRelativeToHome}`;
}

export function hasFreshInUseMark(invokerHome: string, repoHash: string, nowMs: number): boolean {
  const markDir = join(invokerHome, IN_USE_MARK_DIR, 'worktrees', repoHash);
  let entries: string[];
  try {
    entries = readdirSync(markDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }

  const cutoffMs = nowMs - IN_USE_MARK_MAX_AGE_SECONDS * 1000;
  for (const entry of entries) {
    const entryPath = join(markDir, entry);
    const stat = lstatSync(entryPath);
    if (stat.isFile() && stat.mtimeMs >= cutoffMs) return true;
  }
  return false;
}
