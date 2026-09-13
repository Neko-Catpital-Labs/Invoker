import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HEADLESS_IPC = path.join(REPO_ROOT, 'scripts', 'headless-ipc.js');
const TRANSPORT_DIST = path.join(REPO_ROOT, 'packages', 'transport', 'dist', 'index.js');
const CONTRACTS_DIST = path.join(REPO_ROOT, 'packages', 'contracts', 'dist', 'index.js');

function ensureBuilt(pkgFilter, distFile) {
  if (existsSync(distFile)) return;
  const result = spawnSync('pnpm', ['--filter', pkgFilter, 'run', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  assert.equal(result.status, 0, `failed to build ${pkgFilter}`);
  assert.ok(existsSync(distFile), `${distFile} missing after building ${pkgFilter}`);
}

function computeProfileSocketPath(homeDir) {
  const canonicalRoot = realpathSync(REPO_ROOT);
  const id = createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 10);
  const homeRoot = path.join(homeDir, '.invoker', 'dev', id);
  return path.join(homeRoot, 'ipc-transport.sock');
}

function computeDefaultSocketPath(homeDir) {
  return path.join(homeDir, '.invoker', 'ipc-transport.sock');
}

function childEnv(homeDir) {
  const env = { ...process.env, HOME: homeDir };
  delete env.NODE_ENV;
  for (const key of Object.keys(env)) {
    if (key.startsWith('INVOKER_')) delete env[key];
  }
  return env;
}

// Uses async spawn (not spawnSync): the fake owners below run in-process as
// real net servers, and a synchronous spawnSync would block this process's
// event loop for the whole child lifetime, starving those servers of the
// chance to accept/respond to the child's connection.
function runHeadlessExec(homeDir, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      HEADLESS_IPC, 'exec', '--timeout-ms', String(timeoutMs), '--', 'ping',
    ], {
      cwd: REPO_ROOT,
      env: childEnv(homeDir),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe('headless-ipc.js profile-aware socket resolution', () => {
  let transport;
  let tmpHome;
  let decoyBus;
  let profileBus;

  before(async () => {
    ensureBuilt('@invoker/contracts', CONTRACTS_DIST);
    ensureBuilt('@invoker/transport', TRANSPORT_DIST);
    transport = await import(TRANSPORT_DIST);

    const socketTmpRoot = process.platform === 'darwin' ? '/tmp' : tmpdir();
    tmpHome = mkdtempSync(path.join(socketTmpRoot, 'headless-ipc-profile-'));

    const defaultSocketPath = computeDefaultSocketPath(tmpHome);
    const profileSocketPath = computeProfileSocketPath(tmpHome);
    mkdirSync(path.dirname(defaultSocketPath), { recursive: true });
    mkdirSync(path.dirname(profileSocketPath), { recursive: true });

    // "decoy" owner: bound to the plain default (non-profile) socket path.
    // Registers a handler for an unrelated channel only, so a client that
    // reaches it while asking for 'headless.exec' gets a real, deterministic
    // "no handler registered" failure instead of a connection error.
    decoyBus = new transport.IpcBus(defaultSocketPath, { allowServe: true });
    decoyBus.onRequest('some.other.channel', async () => ({ ok: true }));
    await decoyBus.ready();

    // "real" owner: bound to the profile-isolated socket path that
    // with-invoker-development-profile.mjs computes for this repo checkout.
    profileBus = new transport.IpcBus(profileSocketPath, { allowServe: true });
    profileBus.onRequest('headless.exec', async (payload) => ({
      ok: true,
      source: 'profile-isolated-owner',
      receivedArgs: payload.args,
    }));
    await profileBus.ready();
  });

  after(() => {
    decoyBus?.disconnect();
    profileBus?.disconnect();
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  });

  it('reaches the profile-isolated owner instead of the plain default one', async () => {
    const result = await runHeadlessExec(tmpHome, 5_000);

    assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.response.source, 'profile-isolated-owner');
    assert.deepEqual(parsed.response.receivedArgs, ['ping']);
  });
});
