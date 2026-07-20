import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { E2E_BROWSER_REGISTRY_ENV } from './fixtures/browser-process-registry.js';

const E2E_BROWSER_REGISTRY_DIR_PREFIX = 'invoker-e2e-browser-registry-';
const E2E_BROWSER_REGISTRY_FILE = 'user-data-dirs.txt';

export function isManagedBrowserRegistryPath(registryPath: string | undefined): boolean {
  if (!registryPath) return false;
  const resolvedRegistryPath = path.resolve(registryPath);
  const registryDir = path.dirname(resolvedRegistryPath);
  return path.basename(resolvedRegistryPath) === E2E_BROWSER_REGISTRY_FILE
    && path.basename(registryDir).startsWith(E2E_BROWSER_REGISTRY_DIR_PREFIX)
    && path.dirname(registryDir) === path.resolve(tmpdir());
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
  }
}
