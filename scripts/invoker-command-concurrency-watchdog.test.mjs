import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSnapshot, formatViolation } from './invoker-command-concurrency-watchdog.mjs';

const owner = { pid: 100, ppid: 1, command: 'Electron', args: 'Electron packages/app/dist/main.js --headless run plan.yaml' };

describe('invoker command concurrency watchdog', () => {
  it('allows no guarded processes', () => {
    assert.equal(evaluateSnapshot([owner]).ok, true);
  });

  it('allows one codex descendant of owner', () => {
    const result = evaluateSnapshot([owner, { pid: 101, ppid: 100, command: 'codex', args: 'codex exec' }]);
    assert.equal(result.ok, true);
  });

  it('fails on claude plus codex descendants of owner', () => {
    const result = evaluateSnapshot([
      owner,
      { pid: 101, ppid: 100, command: 'claude', args: 'claude' },
      { pid: 102, ppid: 100, command: 'codex', args: 'codex exec' },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.count, 2);
  });

  it('fails on two codex descendants of owner', () => {
    const result = evaluateSnapshot([
      owner,
      { pid: 101, ppid: 100, command: 'codex', args: 'codex exec' },
      { pid: 102, ppid: 100, command: 'codex', args: 'codex exec' },
    ]);
    assert.equal(result.ok, false);
  });

  it('ignores unrelated pnpm outside owner ancestry', () => {
    const result = evaluateSnapshot([
      owner,
      { pid: 101, ppid: 1, command: 'pnpm', args: 'pnpm test' },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.count, 0);
  });

  it('--max 2 allows two guarded processes', () => {
    const result = evaluateSnapshot([
      owner,
      { pid: 101, ppid: 100, command: 'claude', args: 'claude' },
      { pid: 102, ppid: 100, command: 'codex', args: 'codex exec' },
    ], { max: 2 });
    assert.equal(result.ok, true);
  });

  it('violation output includes PID, command, and owner PID', () => {
    const result = evaluateSnapshot([
      owner,
      { pid: 101, ppid: 100, command: 'codex', args: 'codex exec' },
      { pid: 102, ppid: 100, command: 'pnpm', args: 'pnpm install' },
    ]);
    const output = formatViolation(result);
    assert.match(output, /FATAL: Invoker command concurrency invariant violated/);
    assert.match(output, /pid=101/);
    assert.match(output, /command=codex/);
    assert.match(output, /ownerPid=100/);
  });

  it('counts Linux guarded processes under Invoker-managed cwd when ancestry is unavailable', () => {
    const result = evaluateSnapshot([
      {
        pid: 201,
        ppid: 1,
        command: 'pnpm',
        args: 'pnpm test',
        cwd: '/home/user/.invoker/worktrees/hash/experiment-task',
      },
      {
        pid: 202,
        ppid: 1,
        command: 'pnpm',
        args: 'pnpm test',
        cwd: '/home/user/project',
      },
    ], { platform: 'linux' });
    assert.equal(result.count, 1);
    assert.equal(result.offenders[0].pid, 201);
  });
});
