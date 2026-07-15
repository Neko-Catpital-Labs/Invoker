import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { E2E_BROWSER_REGISTRY_ENV } from './fixtures/browser-process-registry.js';

export default async function globalTeardown(): Promise<void> {
  const registryPath = process.env[E2E_BROWSER_REGISTRY_ENV];
  if (!registryPath || !existsSync(registryPath)) return;

  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const cleanupScript = path.join(repoRoot, 'scripts', 'cleanup-orphaned-automation-chrome.mjs');

  try {
    execFileSync(process.execPath, [cleanupScript, '--registry', registryPath], { stdio: 'inherit' });
  } finally {
    rmSync(path.dirname(registryPath), { recursive: true, force: true });
  }
}
