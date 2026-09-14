import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  hasFreshInUseMark,
  IN_USE_MARK_DIR,
  inUseMarkRelativePath,
} from '../workspace-in-use-mark.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('workspace in-use marks', () => {
  it('builds an in-use mark path for managed worktrees', () => {
    expect(inUseMarkRelativePath('worktrees/abc123/task-dir')).toBe(
      `${IN_USE_MARK_DIR}/worktrees/abc123/task-dir`,
    );
  });

  it('rejects non-managed workspace paths', () => {
    expect(() => inUseMarkRelativePath('external/workspace')).toThrow(
      'must start with worktrees/',
    );
  });

  it('returns true when a repo hash has a fresh regular mark file', () => {
    const root = mkdtempTracked('invoker-in-use-fresh-');
    const repoHash = 'repo-hash';
    const markDir = join(root, IN_USE_MARK_DIR, 'worktrees', repoHash);
    mkdirSync(markDir, { recursive: true });
    writeFileSync(join(markDir, 'task-branch'), '');

    expect(hasFreshInUseMark(root, repoHash, Date.now())).toBe(true);
  });

  it('returns false when every mark file is stale', () => {
    const root = mkdtempTracked('invoker-in-use-stale-');
    const repoHash = 'repo-hash';
    const markDir = join(root, IN_USE_MARK_DIR, 'worktrees', repoHash);
    const markPath = join(markDir, 'task-branch');
    mkdirSync(markDir, { recursive: true });
    writeFileSync(markPath, '');

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(markPath, twoHoursAgo, twoHoursAgo);

    expect(hasFreshInUseMark(root, repoHash, Date.now())).toBe(false);
  });

  it('returns false when the repo mark directory is missing', () => {
    const root = mkdtempTracked('invoker-in-use-missing-');

    expect(hasFreshInUseMark(root, 'repo-hash', Date.now())).toBe(false);
  });
});

function mkdtempTracked(prefix: string): string {
  const created = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(created);
  return created;
}
