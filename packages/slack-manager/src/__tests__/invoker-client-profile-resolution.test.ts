import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveInvokerIpcSocketPath } from '@invoker/contracts';
import { IpcBus, type MessageBus } from '@invoker/transport';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IpcInvokerClient } from '../invoker-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = realpathSync(resolve(__dirname, '..', '..', '..', '..'));

function computeProfileSocketPath(homeDir: string): string {
  const id = createHash('sha256').update(REPO_ROOT).digest('hex').slice(0, 10);
  return join(homeDir, '.invoker', 'dev', id, 'ipc-transport.sock');
}

describe('IpcInvokerClient profile-aware socket resolution', () => {
  let tmpHome: string;
  let originalEnv: Record<string, string | undefined>;
  let decoyBus: MessageBus | undefined;
  let profileBus: MessageBus | undefined;
  let client: IpcInvokerClient | undefined;

  beforeEach(() => {
    originalEnv = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('INVOKER_')) delete process.env[key];
    }
    const socketTmpRoot = process.platform === 'darwin' ? '/tmp' : tmpdir();
    tmpHome = mkdtempSync(join(socketTmpRoot, 'invoker-client-profile-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    client?.disconnect();
    decoyBus?.disconnect();
    profileBus?.disconnect();
    client = undefined;
    decoyBus = undefined;
    profileBus = undefined;

    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('reaches the profile-isolated owner instead of the plain default one', async () => {
    const defaultSocketPath = resolveInvokerIpcSocketPath(process.env, tmpHome);
    const profileSocketPath = computeProfileSocketPath(tmpHome);
    mkdirSync(dirname(defaultSocketPath), { recursive: true });
    mkdirSync(dirname(profileSocketPath), { recursive: true });

    // "decoy" owner: bound to the plain default (non-profile) socket path. Never registers
    // headless.owner-ping, so a client that reaches it gets a real, deterministic
    // "no handler registered" failure instead of a hang.
    decoyBus = new IpcBus(defaultSocketPath, { allowServe: true });
    decoyBus.onRequest('some.other.channel', async () => ({ ok: true }));
    await decoyBus.ready();

    // "real" owner: bound to the profile-isolated socket path that
    // with-invoker-development-profile.mjs computes for this repository checkout.
    profileBus = new IpcBus(profileSocketPath, { allowServe: true });
    profileBus.onRequest('headless.owner-ping', async () => ({ ok: true }));
    await profileBus.ready();

    client = new IpcInvokerClient({ spawnInvoker: () => {}, log: () => {} });

    expect(await client.ping()).toBe(true);
  });
});
