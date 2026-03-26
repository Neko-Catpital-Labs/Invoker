import { describe, it, expect } from 'vitest';
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

  it('throws when command task has no repoUrl', async () => {
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
      'has a command but no repoUrl',
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
});
