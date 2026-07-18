import { appendFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';

export const E2E_BROWSER_REGISTRY_ENV = 'INVOKER_E2E_BROWSER_PROCESS_REGISTRY';

export function registerTrackedBrowserUserDataDir(userDataDir: string): void {
  const registryPath = process.env[E2E_BROWSER_REGISTRY_ENV];
  if (!registryPath) return;
  mkdirSync(path.dirname(registryPath), { recursive: true });
  appendFileSync(registryPath, `${userDataDir}\n`, 'utf8');
}
