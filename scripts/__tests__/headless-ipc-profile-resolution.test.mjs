import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

const DEVELOPMENT_PROFILE_KEYS = [
  'INVOKER_DEVELOPMENT_PROFILE',
  'INVOKER_DEVELOPMENT_PROFILE_ACTIVE',
  'INVOKER_RUNTIME_KIND',
  'INVOKER_PRODUCTION_OWNER_SERVICE',
  'INVOKER_SOURCE_ROOT',
  'INVOKER_PROFILE_ID',
  'INVOKER_DB_DIR',
  'INVOKER_USER_DATA_DIR',
  'INVOKER_REPO_CONFIG_PATH',
  'INVOKER_ENV_PATH',
  'INVOKER_LOG_PATH',
  'INVOKER_API_PORT',
  'INVOKER_WEB_PORT',
  'INVOKER_DISABLE_AUTONOMOUS_WORKERS',
  'INVOKER_DISABLE_AUTO_RUN_ON_STARTUP',
];

function childEnv(homeDir, overrides = {}) {
  const env = { ...process.env, HOME: homeDir };
  delete env.NODE_ENV;
  for (const key of DEVELOPMENT_PROFILE_KEYS) delete env[key];
  delete env.INVOKER_HEADLESS_STANDALONE;
  delete env.INVOKER_HEADLESS_REQUIRE_EXISTING_OWNER;
  delete env.INVOKER_IPC_SOCKET;
  return { ...env, ...overrides };
}

// Uses async spawn (not spawnSync): the fake owners below run in-process as
// real net servers, and a synchronous spawnSync would block this process's
// event loop for the whole child lifetime, starving those servers of the
// chance to accept/respond to the child's connection.
function runHeadlessExec(homeDir, timeoutMs, envOverrides = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      HEADLESS_IPC, 'exec', '--timeout-ms', String(timeoutMs), '--', 'ping',
    ], {
      cwd: REPO_ROOT,
      env: childEnv(homeDir, envOverrides),
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
  let productionBus;
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

    productionBus = new transport.IpcBus(defaultSocketPath, { allowServe: true });
    productionBus.onRequest('headless.exec', async (payload) => ({
      ok: true,
      source: 'production-owner',
      receivedArgs: payload.args,
    }));
    await productionBus.ready();

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
    productionBus?.disconnect();
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

  it('reaches the explicit production endpoint without development-profile variables', async () => {
    const productionSocketPath = computeDefaultSocketPath(tmpHome);
    const result = await runHeadlessExec(tmpHome, 5_000, {
      INVOKER_IPC_SOCKET: productionSocketPath,
      INVOKER_HEADLESS_REQUIRE_EXISTING_OWNER: '1',
    });

    assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.response.source, 'production-owner');
    assert.deepEqual(parsed.response.receivedArgs, ['ping']);
  });

  it('requires an explicit existing-owner endpoint instead of auto-resolving development', async () => {
    const result = await runHeadlessExec(tmpHome, 5_000, {
      INVOKER_HEADLESS_REQUIRE_EXISTING_OWNER: '1',
    });

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /requires an explicit INVOKER_IPC_SOCKET endpoint/,
    );
  });

  it('does not bootstrap a standalone client when existing-owner transport is unavailable', () => {
    const isolatedRoot = mkdtempSync(path.join(tmpdir(), 'headless-ipc-existing-owner-'));
    const isolatedScript = path.join(isolatedRoot, 'scripts', 'headless-ipc.js');
    const standaloneClient = path.join(isolatedRoot, 'packages', 'app', 'dist', 'headless-client.js');
    const bootstrapMarker = path.join(isolatedRoot, 'standalone-bootstrap-ran');
    mkdirSync(path.dirname(isolatedScript), { recursive: true });
    mkdirSync(path.dirname(standaloneClient), { recursive: true });
    copyFileSync(HEADLESS_IPC, isolatedScript);
    writeFileSync(
      standaloneClient,
      `require('node:fs').writeFileSync(${JSON.stringify(bootstrapMarker)}, 'ran');\n`,
    );

    try {
      const result = spawnSync(process.execPath, [
        isolatedScript, 'exec', '--timeout-ms', '100', '--', 'ping',
      ], {
        cwd: isolatedRoot,
        encoding: 'utf8',
        env: childEnv(tmpHome, {
          INVOKER_IPC_SOCKET: computeDefaultSocketPath(tmpHome),
          INVOKER_HEADLESS_REQUIRE_EXISTING_OWNER: '1',
        }),
      });

      assert.notEqual(result.status, 0);
      assert.equal(existsSync(bootstrapMarker), false, 'standalone headless client must not run');
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });
});
