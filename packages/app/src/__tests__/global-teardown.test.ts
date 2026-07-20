import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isManagedBrowserRegistryPath } from '../../e2e/global-teardown';

describe('global teardown browser registry cleanup guard', () => {
  it('accepts the Playwright-managed browser registry path', () => {
    const registryPath = path.join(tmpdir(), 'invoker-e2e-browser-registry-abc123', 'user-data-dirs.txt');

    expect(isManagedBrowserRegistryPath(registryPath)).toBe(true);
  });

  it('rejects arbitrary env-derived parent directories', () => {
    expect(isManagedBrowserRegistryPath(path.join(tmpdir(), 'workspace', 'user-data-dirs.txt'))).toBe(false);
    expect(isManagedBrowserRegistryPath('/var/tmp/invoker-e2e-browser-registry-abc123/user-data-dirs.txt')).toBe(false);
    expect(isManagedBrowserRegistryPath(path.join(tmpdir(), 'invoker-e2e-browser-registry-abc123', 'other.txt'))).toBe(false);
  });
});
