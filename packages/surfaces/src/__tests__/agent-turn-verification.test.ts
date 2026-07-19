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
});
