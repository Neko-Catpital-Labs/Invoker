import { describe, it, expect, vi } from 'vitest';
import { SshFamiliar } from '../ssh-familiar.js';
import type { WorkRequest } from '@invoker/protocol';

function makeRequest(overrides: Partial<WorkRequest> = {}): WorkRequest {
  return {
    requestId: 'req-1',
    actionId: 'test-task',
    actionType: 'command',
    inputs: { command: 'echo hello', description: 'test' },
    callbackUrl: '',
    timestamps: { createdAt: new Date().toISOString() },
    ...overrides,
  };
}

describe('SshFamiliar pre-flight validation', () => {
  it('throws when SSH key file does not exist', async () => {
    const ssh = new SshFamiliar({
      host: 'localhost',
      user: 'root',
      sshKeyPath: '/nonexistent/path/id_ed25519',
    });
    await expect(ssh.start(makeRequest())).rejects.toThrow(
      'SSH key file not accessible',
    );
  });

  it('throws when task has no repoUrl', async () => {
    // Use /dev/null as a readable file to pass the key check
    const ssh = new SshFamiliar({
      host: 'localhost',
      user: 'root',
      sshKeyPath: '/dev/null',
    });
    const req = makeRequest({
      inputs: {
        command: 'cd packages/app && pnpm test',
        description: 'test',
      },
    });
    await expect(ssh.start(req)).rejects.toThrow(
      'requires repoUrl',
    );
  });

  it('does not throw for reconciliation requests', async () => {
    const ssh = new SshFamiliar({
      host: 'localhost',
      user: 'root',
      sshKeyPath: '/nonexistent/path/id_ed25519',
    });
    const req = makeRequest({ actionType: 'reconciliation' });
    const handle = await ssh.start(req);
    expect(handle).toBeDefined();
    expect(handle.executionId).toBeDefined();
  });

  it('falls back to a resolvable base ref when requested baseBranch is missing on remote', async () => {
    const ssh = new SshFamiliar({
      host: 'localhost',
      user: 'root',
      sshKeyPath: '/dev/null',
    }) as any;

    vi.spyOn(ssh, 'execRemoteCapture').mockImplementation(async (script: string) => {
      if (script.includes('__INVOKER_BASE_REF__=')) {
        return [
          "__INVOKER_BASE_WARNING__=Requested base 'plan/nonexistent' not found; falling back to 'origin/master'.",
          '__INVOKER_BASE_REF__=origin/master',
          '__INVOKER_BASE_HEAD__=0123456789abcdef0123456789abcdef01234567',
          '',
        ].join('\n');
      }
      if (script.includes('printf %s "$HOME"')) return '/home/root';
      if (script.includes('worktree list --porcelain')) return '';
      return '';
    });

    const setupTaskBranchSpy = vi.spyOn(ssh, 'setupTaskBranch').mockResolvedValue(undefined);
    vi.spyOn(ssh, 'spawnSshRemoteStdin').mockImplementation(async (_executionId: string, _request: any, handle: any) => handle);

    const req = makeRequest({
      actionType: 'command',
      inputs: {
        command: 'echo hello',
        description: 'test',
        repoUrl: 'git@github.com:owner/repo.git',
        baseBranch: 'plan/nonexistent',
      },
    });

    const handle = await ssh.start(req);
    expect(handle.workspacePath).toContain('/.invoker/worktrees/');
    expect(setupTaskBranchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ base: 'origin/master' }),
    );
  });
});
