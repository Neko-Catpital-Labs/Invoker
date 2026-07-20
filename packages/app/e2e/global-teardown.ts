import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import * as path from 'node:path';
import { E2E_BROWSER_REGISTRY_ENV } from './fixtures/browser-process-registry.js';

export default async function globalTeardown(): Promise<void> {
  const registryPath = process.env[E2E_BROWSER_REGISTRY_ENV];

  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const cleanupScript = path.join(repoRoot, 'scripts', 'cleanup-orphaned-automation-chrome.mjs');
  const cleanupArgs = registryPath ? [cleanupScript, '--registry', registryPath] : [cleanupScript];

  try {
    execFileSync(process.execPath, cleanupArgs, { stdio: 'inherit' });
  } finally {
    if (registryPath) {
      rmSync(path.dirname(registryPath), { recursive: true, force: true });
    }
  }
}
