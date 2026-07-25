import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildUnverifiedNotice,
  captureRepoState,
  looksLikeCompletionClaim,
  repoStateUnchanged,
  restoreTrackedChanges,
  trackedFilesChanged,
} from '../slack/agent-turn-verification.js';

describe('agent turn verification', () => {
  it('captures HEAD and porcelain status from a git worktree', async () => {
    const workingDir = mkdtempSync(join(tmpdir(), 'invoker-agent-state-'));
    execFileSync('git', ['init'], { cwd: workingDir });

    try {
      const initial = await captureRepoState(workingDir);
      writeFileSync(join(workingDir, 'changed.txt'), 'changed\n');
      const changed = await captureRepoState(workingDir);

      expect(initial).toEqual({ headSha: null, statusPorcelain: '' });
      expect(changed).toEqual({ headSha: null, statusPorcelain: '?? changed.txt' });
      expect(repoStateUnchanged(initial, changed)).toBe(false);
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
    }
  });

  it('detects completion claims and labels unchanged worktrees', () => {
    expect(looksLikeCompletionClaim('Fixed.\nChanged: routing.\nVerified: tests passed.')).toBe(true);
    expect(looksLikeCompletionClaim('I inspected the routing code.')).toBe(false);
    expect(buildUnverifiedNotice()).toContain('could not be verified');
  });

  it('detects and restores tracked-file changes while preserving new repro artifacts', async () => {
    const workingDir = mkdtempSync(join(tmpdir(), 'invoker-agent-guard-'));
    execFileSync('git', ['init'], { cwd: workingDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workingDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: workingDir });
    writeFileSync(join(workingDir, 'tracked.txt'), 'before\n');
    execFileSync('git', ['add', '.'], { cwd: workingDir });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: workingDir });
    try {
      const before = await captureRepoState(workingDir);
      writeFileSync(join(workingDir, 'tracked.txt'), 'after\n');
      writeFileSync(join(workingDir, 'repro.txt'), 'repro\n');
      const after = await captureRepoState(workingDir);
      expect(trackedFilesChanged(before, after)).toBe(true);
      restoreTrackedChanges(workingDir);
      expect(await captureRepoState(workingDir)).toMatchObject({ statusPorcelain: '?? repro.txt' });
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
    }
  });
});
