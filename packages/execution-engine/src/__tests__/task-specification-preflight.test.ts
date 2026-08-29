import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildRemoteTaskFreshnessScript,
  evaluateTaskFreshness,
  inspectTaskFreshness,
  parseRemoteTaskFreshnessReport,
  parseTaskFreshnessSpecification,
} from '../task-specification-preflight.js';

const CAMERA_TASK = `
Files:
- packages/ui/src/App.tsx
- packages/ui/src/lib/graph-camera.ts

Preserve guarded-behavior: selection-camera-inert.
Modify the existing \`packages/ui/src/lib/graph-camera.ts\`; do not create it.
`;

describe('stale task specification preflight', () => {
  it('stops the old camera task when a referenced path changed after its snapshot', () => {
    const specification = parseTaskFreshnessSpecification(CAMERA_TASK);

    expect(evaluateTaskFreshness({
      snapshotCommit: 'old-camera-base',
      currentCommit: 'current-base',
      specification,
      changedPaths: ['packages/ui/src/App.tsx'],
      changedGuardedBehaviorIds: [],
      missingAnchors: [],
    })).toEqual({
      status: 'stale',
      snapshotCommit: 'old-camera-base',
      currentCommit: 'current-base',
      changedReferencedPaths: ['packages/ui/src/App.tsx'],
      changedGuardedBehaviorIds: [],
      missingAnchors: [],
      message: expect.stringContaining('replan/recreate'),
    });
  });

  it('stops when a named guarded behavior changed', () => {
    const specification = parseTaskFreshnessSpecification(CAMERA_TASK);

    expect(evaluateTaskFreshness({
      snapshotCommit: 'old-camera-base',
      currentCommit: 'current-base',
      specification,
      changedPaths: ['packages/ui/src/other.ts'],
      changedGuardedBehaviorIds: ['selection-camera-inert'],
      missingAnchors: [],
    })).toMatchObject({
      status: 'stale',
      changedGuardedBehaviorIds: ['selection-camera-inert'],
    });
  });

  it('stops when an explicit existing/do-not-create anchor is absent', () => {
    const specification = parseTaskFreshnessSpecification(CAMERA_TASK);

    expect(evaluateTaskFreshness({
      snapshotCommit: 'old-camera-base',
      currentCommit: 'current-base',
      specification,
      changedPaths: [],
      changedGuardedBehaviorIds: [],
      missingAnchors: specification.anchors,
    })).toMatchObject({
      status: 'stale',
      missingAnchors: [
        expect.objectContaining({
          kind: 'path',
          value: 'packages/ui/src/lib/graph-camera.ts',
        }),
      ],
    });
  });

  it('allows unrelated base changes and current-base attempts', () => {
    const specification = parseTaskFreshnessSpecification(CAMERA_TASK);

    expect(evaluateTaskFreshness({
      snapshotCommit: 'old-camera-base',
      currentCommit: 'current-base',
      specification,
      changedPaths: ['README.md'],
      changedGuardedBehaviorIds: [],
      missingAnchors: [],
    })).toEqual({ status: 'current' });

    expect(evaluateTaskFreshness({
      snapshotCommit: 'current-base',
      currentCommit: 'current-base',
      specification,
      changedPaths: ['packages/ui/src/App.tsx'],
      changedGuardedBehaviorIds: ['selection-camera-inert'],
      missingAnchors: [],
    })).toEqual({ status: 'current' });
  });

  it('does not invent anchors from ordinary file references', () => {
    const specification = parseTaskFreshnessSpecification('Modify packages/ui/src/App.tsx.');

    expect(specification.referencedPaths).toEqual(['packages/ui/src/App.tsx']);
    expect(specification.anchors).toEqual([]);
  });

  it('returns the same terminal decision for a repeated mismatch', () => {
    const specification = parseTaskFreshnessSpecification(CAMERA_TASK);
    const input = {
      snapshotCommit: 'old-camera-base',
      currentCommit: 'current-base',
      specification,
      changedPaths: ['packages/ui/src/App.tsx'],
      changedGuardedBehaviorIds: [] as string[],
      missingAnchors: [] as typeof specification.anchors,
    };

    expect(evaluateTaskFreshness(input)).toEqual(evaluateTaskFreshness(input));
    expect(evaluateTaskFreshness(input).status).toBe('stale');
  });

  it('inspects the real pre-agent git boundary for changed referenced paths', async () => {
    const gitCalls: string[][] = [];
    const decision = await inspectTaskFreshness({
      cwd: '/repo',
      snapshotCommit: 'old-camera-base',
      taskText: 'Modify packages/ui/src/App.tsx.',
      runGit: async args => {
        gitCalls.push(args);
        if (args[0] === 'rev-parse') return 'current-base\n';
        if (args[0] === 'cat-file') return '';
        if (args[1] === '--name-only') return 'packages/ui/src/App.tsx\n';
        if (args[1] === '--unified=0') return '';
        throw new Error(`unexpected git call: ${args.join(' ')}`);
      },
    });

    expect(decision).toMatchObject({
      status: 'stale',
      snapshotCommit: 'old-camera-base',
      currentCommit: 'current-base',
      changedReferencedPaths: ['packages/ui/src/App.tsx'],
    });
    expect(gitCalls).toContainEqual([
      'diff', '--name-only', 'old-camera-base', 'current-base', '--',
    ]);
  });

  it('stops when the immutable snapshot can no longer be resolved', async () => {
    const decision = await inspectTaskFreshness({
      cwd: '/repo',
      snapshotCommit: 'missing-camera-base',
      taskText: 'Modify packages/ui/src/App.tsx.',
      runGit: async args => {
        if (args[0] === 'rev-parse') return 'current-base\n';
        if (args[0] === 'cat-file') throw new Error('bad object');
        throw new Error(`unexpected git call: ${args.join(' ')}`);
      },
    });

    expect(decision).toMatchObject({
      status: 'stale',
      snapshotUnavailable: true,
      snapshotCommit: 'missing-camera-base',
      currentCommit: 'current-base',
      message: expect.stringContaining('replan/recreate'),
    });
  });

  it('runs the same referenced-path guard in an SSH-compatible shell', () => {
    const repo = mkdtempSync(join(tmpdir(), 'invoker-stale-task-preflight-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
      mkdirSync(join(repo, 'packages/ui/src'), { recursive: true });
      const appPath = join(repo, 'packages/ui/src/App.tsx');
      writeFileSync(appPath, 'export const camera = "selection-only";\n');
      execFileSync('git', ['add', '.'], { cwd: repo });
      execFileSync('git', ['commit', '-qm', 'old camera base'], { cwd: repo });
      const snapshotCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      writeFileSync(appPath, 'export const camera = "selection-recenter";\n');
      execFileSync('git', ['commit', '-qam', 'change camera behavior'], { cwd: repo });

      const output = execFileSync('bash', ['-c', buildRemoteTaskFreshnessScript({
        cwd: repo,
        snapshotCommit,
        taskText: 'Modify packages/ui/src/App.tsx.',
      })], { encoding: 'utf8' });

      expect(parseRemoteTaskFreshnessReport(output)).toMatchObject({
        reasons: ['path:packages/ui/src/App.tsx'],
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('expands a tilde-prefixed remote working directory before checking freshness', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'invoker-stale-task-remote-home-'));
    const repo = join(fakeHome, 'workspace');
    try {
      mkdirSync(repo);
      execFileSync('git', ['init', '-q'], { cwd: repo });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
      mkdirSync(join(repo, 'packages/ui/src'), { recursive: true });
      const appPath = join(repo, 'packages/ui/src/App.tsx');
      writeFileSync(appPath, 'export const camera = "selection-only";\n');
      execFileSync('git', ['add', '.'], { cwd: repo });
      execFileSync('git', ['commit', '-qm', 'old camera base'], { cwd: repo });
      const snapshotCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      writeFileSync(appPath, 'export const camera = "selection-recenter";\n');
      execFileSync('git', ['commit', '-qam', 'change camera behavior'], { cwd: repo });

      const output = execFileSync('bash', ['-c', buildRemoteTaskFreshnessScript({
        cwd: '~/workspace',
        snapshotCommit,
        taskText: 'Modify packages/ui/src/App.tsx.',
      })], {
        encoding: 'utf8',
        env: { ...process.env, HOME: fakeHome },
      });

      expect(parseRemoteTaskFreshnessReport(output)).toMatchObject({
        reasons: ['path:packages/ui/src/App.tsx'],
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('is wired before command construction and stops with needs_input', () => {
    const executorSource = readFileSync(new URL('../worktree-executor.ts', import.meta.url), 'utf8');
    const freshnessIndex = executorSource.indexOf('const freshness = await inspectTaskFreshness');
    const commandIndex = executorSource.indexOf('const { cmd, args, agentSessionId } = this.buildCommandAndArgs');

    expect(freshnessIndex).toBeGreaterThan(-1);
    expect(commandIndex).toBeGreaterThan(freshnessIndex);
    expect(executorSource.slice(freshnessIndex, commandIndex)).toContain("status: 'needs_input'");

    const prepareSource = readFileSync(new URL('../task-runner-prepare.ts', import.meta.url), 'utf8');
    expect(prepareSource).toContain('specificationSnapshotCommit');
    expect(prepareSource).toContain('loadAttempt.call(host.persistence, attemptId)?.snapshotCommit');

    const sshSource = readFileSync(new URL('../ssh-executor.ts', import.meta.url), 'utf8');
    const sshFreshnessIndex = sshSource.indexOf('await this.inspectRemoteTaskFreshness');
    const sshSpawnIndex = sshSource.indexOf('await this.spawnSshRemoteStdin');
    expect(sshFreshnessIndex).toBeGreaterThan(-1);
    expect(sshSpawnIndex).toBeGreaterThan(sshFreshnessIndex);
  });
});
