import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveInvokerIpcSocketPath } from '@invoker/contracts';
import { IpcBus, type MessageBus } from '@invoker/transport';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDefaultMessageBus } from '../live-owner-bus.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = realpathSync(resolve(__dirname, '..', '..', '..', '..'));

function computeProfileSocketPath(homeDir: string): string {
  const id = createHash('sha256').update(REPO_ROOT).digest('hex').slice(0, 10);
  return join(homeDir, '.invoker', 'dev', id, 'ipc-transport.sock');
}

describe('createDefaultMessageBus profile-aware socket resolution', () => {
  let tmpHome: string;
  let originalEnv: Record<string, string | undefined>;
  let decoyBus: MessageBus | undefined;
  let profileBus: MessageBus | undefined;
  let clientBus: MessageBus | undefined;

  beforeEach(() => {
    originalEnv = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('INVOKER_')) delete process.env[key];
    }
    const socketTmpRoot = process.platform === 'darwin' ? '/tmp' : tmpdir();
    tmpHome = mkdtempSync(join(socketTmpRoot, 'live-owner-bus-profile-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    clientBus?.disconnect();
    decoyBus?.disconnect();
    profileBus?.disconnect();
    clientBus = undefined;
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

    // "decoy" owner: bound to the plain default (non-profile) socket path. Registers a
    // handler for an unrelated channel only, so a client that reaches it while asking for
    // the test channel gets a real, deterministic "no handler registered" failure instead
    // of a connection error or a hang.
    decoyBus = new IpcBus(defaultSocketPath, { allowServe: true });
    decoyBus.onRequest('some.other.channel', async () => ({ ok: true }));
    await decoyBus.ready();

    // "real" owner: bound to the profile-isolated socket path that
    // with-invoker-development-profile.mjs computes for this repository checkout.
    profileBus = new IpcBus(profileSocketPath, { allowServe: true });
    profileBus.onRequest('live-owner-bus-test.ping', async () => ({
      source: 'profile-isolated-owner',
    }));
    await profileBus.ready();

    clientBus = await createDefaultMessageBus();

    const response = await clientBus.request('live-owner-bus-test.ping', {});
    expect(response).toEqual({ source: 'profile-isolated-owner' });
  });
});
