#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir, platform, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultSourceRoot = realpathSync(resolve(scriptDir, '..'));

function fail(message) {
  process.stderr.write(`[invoker-development-profile] ${message}\n`);
  process.exit(2);
}

function productionUserDataDir(homeDir) {
  if (platform() === 'darwin') return join(homeDir, 'Library', 'Application Support', 'Invoker');
  if (platform() === 'win32') return join(process.env.APPDATA ?? join(homeDir, 'AppData', 'Roaming'), 'Invoker');
  return join(process.env.XDG_CONFIG_HOME ?? join(homeDir, '.config'), 'Invoker');
}

function developmentEnvironment(sourceRoot, env = process.env) {
  const canonicalRoot = realpathSync(resolve(sourceRoot));
  const id = createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 10);
  const defaultHomeRoot = join(homedir(), '.invoker', 'dev', id);
  const homeRoot = env.INVOKER_DB_DIR?.trim() || defaultHomeRoot;
  const apiPort = 41000 + (Number.parseInt(id.slice(0, 8), 16) % 900);
  return {
    INVOKER_DEVELOPMENT_PROFILE: '1',
    INVOKER_DEVELOPMENT_PROFILE_ACTIVE: '1',
    INVOKER_RUNTIME_KIND: 'source-development',
    INVOKER_SOURCE_ROOT: canonicalRoot,
    INVOKER_PROFILE_ID: id,
    INVOKER_DB_DIR: homeRoot,
    INVOKER_USER_DATA_DIR: env.INVOKER_USER_DATA_DIR?.trim() || join(homeRoot, 'electron'),
    INVOKER_IPC_SOCKET: env.INVOKER_IPC_SOCKET?.trim() || join(homeRoot, 'ipc-transport.sock'),
    INVOKER_REPO_CONFIG_PATH: env.INVOKER_REPO_CONFIG_PATH?.trim() || join(homeRoot, 'config.json'),
    INVOKER_ENV_PATH: env.INVOKER_ENV_PATH?.trim() || join(homeRoot, '.env'),
    INVOKER_LOG_PATH: env.INVOKER_LOG_PATH?.trim() || join(homeRoot, 'invoker.log'),
    INVOKER_API_PORT: String(apiPort),
    INVOKER_WEB_PORT: String(apiPort + 1000),
    INVOKER_DISABLE_AUTONOMOUS_WORKERS: '1',
    INVOKER_DISABLE_AUTO_RUN_ON_STARTUP: '1',
  };
}

function resolveValue(name, value) {
  return name.endsWith('_PORT') ? String(value) : resolve(String(value));
}

function realHomeDir() {
  // Unlike os.homedir(), userInfo().homedir ignores an overridden $HOME —
  // needed so a caller's own sandboxed $HOME/.invoker isn't mistaken for
  // the real production namespace this guard protects.
  try {
    return userInfo().homedir || homedir();
  } catch {
    return homedir();
  }
}

function assertNoProductionCollision(env) {
  const homeDir = realHomeDir();
  const productionHome = join(homeDir, '.invoker');
  const forbidden = new Map([
    ['INVOKER_DB_DIR', productionHome],
    ['INVOKER_USER_DATA_DIR', productionUserDataDir(homeDir)],
    ['INVOKER_IPC_SOCKET', join(productionHome, 'ipc-transport.sock')],
    ['INVOKER_REPO_CONFIG_PATH', join(productionHome, 'config.json')],
    ['INVOKER_ENV_PATH', join(productionHome, '.env')],
    ['INVOKER_LOG_PATH', join(productionHome, 'invoker.log')],
    ['INVOKER_API_PORT', '4100'],
    ['INVOKER_WEB_PORT', '4200'],
  ]);
  for (const [name, productionValue] of forbidden) {
    if (env[name] && resolveValue(name, env[name]) === resolveValue(name, productionValue)) {
      fail(`${name} points at the production profile (${productionValue}); refusing to start source development.`);
    }
  }
}

let args = process.argv.slice(2);
let sourceRoot = defaultSourceRoot;
let shell = false;
let printEnv = false;
let productionOwnerService = false;

while (args.length > 0) {
  if (args[0] === '--') {
    args = args.slice(1);
    break;
  }
  if (args[0] === '--source-root') {
    if (!args[1]) fail('--source-root requires a path');
    sourceRoot = args[1];
    args = args.slice(2);
    continue;
  }
  if (args[0] === '--shell') {
    shell = true;
    args = args.slice(1);
    break;
  }
  if (args[0] === '--print-env') {
    printEnv = true;
    args = args.slice(1);
    continue;
  }
  if (args[0] === '--production-owner-service') {
    productionOwnerService = true;
    args = args.slice(1);
    continue;
  }
  fail(`unknown option: ${args[0]}`);
}

if (productionOwnerService) {
  if (printEnv && args.length === 0) {
    process.stdout.write(`${JSON.stringify({ INVOKER_RUNTIME_KIND: 'packaged', INVOKER_PRODUCTION_OWNER_SERVICE: '1' })}\n`);
    process.exit(0);
  }
  if (args.length !== 3 || basename(args[0]) !== 'invoker-cli' || args[1] !== 'owner' || args[2] !== 'serve') {
    fail('the production exception accepts exactly: invoker-cli owner serve');
  }
  const result = spawnSync(args[0], args.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, INVOKER_RUNTIME_KIND: 'packaged', INVOKER_PRODUCTION_OWNER_SERVICE: '1' },
  });
  process.exit(result.status ?? 1);
}

assertNoProductionCollision(process.env);
const profile = developmentEnvironment(sourceRoot);
const childEnv = { ...process.env, ...profile };
delete childEnv.ELECTRON_RUN_AS_NODE;

if (printEnv) {
  process.stdout.write(`${JSON.stringify(profile)}\n`);
  if (args.length === 0) process.exit(0);
}
if (args.length === 0) fail('missing command after --');

const shellArgs = args[1] === '--' ? args.slice(2) : args.slice(1);
const result = shell
  ? spawnSync(args[0], shellArgs, { stdio: 'inherit', env: childEnv, shell: true })
  : spawnSync(args[0], args.slice(1), { stdio: 'inherit', env: childEnv });
if (result.error) fail(result.error.message);
process.exit(result.status ?? 1);
