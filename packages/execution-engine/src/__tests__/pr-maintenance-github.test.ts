import { describe, it, expect, vi } from 'vitest';
import { createPrMaintenanceGitHub } from '../workers/pr-maintenance-github.js';
import type { PrMaintenanceCommandResult, PrMaintenanceCommandSpec } from '../workers/pr-maintenance-command.js';

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => noopLogger),
} as any;

function ok(stdout = ''): PrMaintenanceCommandResult {
  return { code: 0, signal: null, stdout, stderr: '', timedOut: false };
}

function fail(): PrMaintenanceCommandResult {
  return { code: 1, signal: null, stdout: '', stderr: 'boom', timedOut: false };
}

describe('closePullRequest', () => {
  it('closes without --delete-branch by default', async () => {
    const calls: PrMaintenanceCommandSpec[] = [];
    const run = vi.fn(async (spec: PrMaintenanceCommandSpec) => {
      calls.push(spec);
      return ok();
    });
    const gh = createPrMaintenanceGitHub({ run, repo: 'org/repo', author: 'invoker', logger: noopLogger, sleep: async () => {} });

    const result = await gh.closePullRequest(42);

    expect(result).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['pr', 'close', '42', '--repo', 'org/repo']);
  });

  it('adds --delete-branch when requested', async () => {
    const calls: PrMaintenanceCommandSpec[] = [];
    const run = vi.fn(async (spec: PrMaintenanceCommandSpec) => {
      calls.push(spec);
      return ok();
    });
    const gh = createPrMaintenanceGitHub({ run, repo: 'org/repo', author: 'invoker', logger: noopLogger, sleep: async () => {} });

    await gh.closePullRequest(42, { deleteBranch: true });

    expect(calls[0].args).toEqual(['pr', 'close', '42', '--repo', 'org/repo', '--delete-branch']);
  });

  it('retries once on failure and succeeds if the retry passes', async () => {
    let attempt = 0;
    const run = vi.fn(async () => {
      attempt += 1;
      return attempt === 1 ? fail() : ok();
    });
    const gh = createPrMaintenanceGitHub({ run, repo: 'org/repo', author: 'invoker', logger: noopLogger, sleep: async () => {} });

    const result = await gh.closePullRequest(42, { deleteBranch: true });

    expect(result).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('returns false when both the attempt and the retry fail', async () => {
    const run = vi.fn(async () => fail());
    const gh = createPrMaintenanceGitHub({ run, repo: 'org/repo', author: 'invoker', logger: noopLogger, sleep: async () => {} });

    const result = await gh.closePullRequest(42, { deleteBranch: true });

    expect(result).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
