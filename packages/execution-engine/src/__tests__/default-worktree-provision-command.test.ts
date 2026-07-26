import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_WORKTREE_PROVISION_COMMAND } from '../default-worktree-provision-command.js';

describe('DEFAULT_WORKTREE_PROVISION_COMMAND', () => {
  it('installs pnpm dependencies only when a pnpm workspace is not hydrated', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'invoker-local-pnpm-bootstrap-'));
    const workspace = join(tmp, 'workspace');
    const binDir = join(tmp, 'bin');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    const pnpmPath = join(binDir, 'pnpm');
    writeFileSync(
      pnpmPath,
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" > "$TMPDIR/pnpm-args.txt"\nprintf "%s\\n" "$PWD" > "$TMPDIR/pnpm-cwd.txt"\nmkdir -p node_modules\n',
    );
    chmodSync(pnpmPath, 0o755);

    try {
      const first = spawnSync('/bin/bash', ['-c', DEFAULT_WORKTREE_PROVISION_COMMAND], {
        cwd: workspace,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`, TMPDIR: tmp },
      });

      expect(first.status).toBe(0);
      expect(first.stdout).toContain('[WorktreeExecutor] Installing pnpm dependencies for managed worktree...');
      expect(readFileSync(join(tmp, 'pnpm-args.txt'), 'utf8')).toBe('install --frozen-lockfile\n');
      expect(readFileSync(join(tmp, 'pnpm-cwd.txt'), 'utf8')).toBe(`${realpathSync(workspace)}\n`);
      expect(existsSync(join(workspace, 'node_modules'))).toBe(true);

      rmSync(join(tmp, 'pnpm-args.txt'));
      rmSync(join(tmp, 'pnpm-cwd.txt'));
      const second = spawnSync('/bin/bash', ['-c', DEFAULT_WORKTREE_PROVISION_COMMAND], {
        cwd: workspace,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`, TMPDIR: tmp },
      });

      expect(second.status).toBe(0);
      expect(second.stdout).not.toContain('Installing pnpm dependencies');
      expect(existsSync(join(tmp, 'pnpm-args.txt'))).toBe(false);
      expect(existsSync(join(tmp, 'pnpm-cwd.txt'))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
