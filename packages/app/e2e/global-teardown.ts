import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { E2E_BROWSER_REGISTRY_ENV } from './fixtures/browser-process-registry.js';

const E2E_BROWSER_REGISTRY_DIR_PREFIX = 'invoker-e2e-browser-registry-';
const E2E_BROWSER_REGISTRY_FILE = 'user-data-dirs.txt';
const E2E_XVFB_STATE_DIR_PREFIX = 'invoker-e2e-xvfb-';
const E2E_XVFB_STATE_FILE = 'xvfb.json';

export function isManagedBrowserRegistryPath(registryPath: string | undefined): boolean {
  if (!registryPath) return false;
  const resolvedRegistryPath = path.resolve(registryPath);
  const registryDir = path.dirname(resolvedRegistryPath);
  return path.basename(resolvedRegistryPath) === E2E_BROWSER_REGISTRY_FILE
    && path.basename(registryDir).startsWith(E2E_BROWSER_REGISTRY_DIR_PREFIX)
    && path.dirname(registryDir) === path.resolve(tmpdir());
}

export function isManagedXvfbStatePath(statePath: string | undefined): boolean {
  if (!statePath) return false;
  const resolvedStatePath = path.resolve(statePath);
  const stateDir = path.dirname(resolvedStatePath);
  return path.basename(resolvedStatePath) === E2E_XVFB_STATE_FILE
    && path.basename(stateDir).startsWith(E2E_XVFB_STATE_DIR_PREFIX)
    && path.dirname(stateDir) === path.resolve(tmpdir());
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopManagedXvfb(): Promise<void> {
  const statePath = process.env.INVOKER_E2E_XVFB_STATE;
  if (!statePath || !existsSync(statePath)) return;

  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { pid?: unknown };
    const pid = typeof state.pid === 'number' ? state.pid : null;
    if (!pid || pid <= 0 || !processIsAlive(pid)) return;

    process.kill(pid, 'SIGTERM');
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!processIsAlive(pid)) return;
      await delay(50);
    }
    if (processIsAlive(pid)) process.kill(pid, 'SIGKILL');
  } catch {
    // Best-effort cleanup; test failures should stay focused on their own signal.
  } finally {
    if (isManagedXvfbStatePath(statePath)) {
      rmSync(path.dirname(path.resolve(statePath)), { recursive: true, force: true });
    }
  }
}

export default async function globalTeardown(): Promise<void> {
  const registryPath = process.env[E2E_BROWSER_REGISTRY_ENV];

  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const cleanupScript = path.join(repoRoot, 'scripts', 'cleanup-orphaned-automation-chrome.mjs');
  const cleanupArgs = registryPath ? [cleanupScript, '--registry', registryPath] : [cleanupScript];

  try {
    execFileSync(process.execPath, cleanupArgs, { stdio: 'inherit' });
  } finally {
    if (isManagedBrowserRegistryPath(registryPath)) {
      rmSync(path.dirname(path.resolve(registryPath)), { recursive: true, force: true });
    }
    await stopManagedXvfb();
  }
}
