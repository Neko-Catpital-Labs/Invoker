import { afterEach, describe, expect, it } from 'vitest';
import { buildSshConnectionArgs } from '../ssh-transport-options.js';

const previousKnownHosts = process.env.INVOKER_SSH_USER_KNOWN_HOSTS_FILE;

afterEach(() => {
  if (previousKnownHosts === undefined) delete process.env.INVOKER_SSH_USER_KNOWN_HOSTS_FILE;
  else process.env.INVOKER_SSH_USER_KNOWN_HOSTS_FILE = previousKnownHosts;
});

describe('ssh transport options', () => {
  it('uses default known_hosts behavior when no override is configured', () => {
    delete process.env.INVOKER_SSH_USER_KNOWN_HOSTS_FILE;

    const args = buildSshConnectionArgs({
      host: 'localhost',
      user: 'invoker',
      sshKeyPath: '/tmp/key',
      port: 2222,
    }, { batchMode: true });

    expect(args).toContain('StrictHostKeyChecking=accept-new');
    expect(args.join('\n')).not.toContain('UserKnownHostsFile=');
  });

  it('honors a caller-provided known_hosts file', () => {
    process.env.INVOKER_SSH_USER_KNOWN_HOSTS_FILE = '/tmp/invoker-e2e-known-hosts';

    const args = buildSshConnectionArgs({
      host: 'localhost',
      user: 'invoker',
      sshKeyPath: '/tmp/key',
    }, { batchMode: true });

    expect(args).toContain('UserKnownHostsFile=/tmp/invoker-e2e-known-hosts');
    expect(args).toContain('StrictHostKeyChecking=accept-new');
  });
});
