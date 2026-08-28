import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveActiveInvokerProfileEnv, resolveInvokerIpcSocketPath, resolveRepoRoot } from '../index.js';

const tempDirs: string[] = [];

function makeRepoWithProfileScript(source: string): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'invoker-profile-env-'));
  tempDirs.push(repoRoot);
  const scriptsDir = join(repoRoot, 'scripts');
  mkdirSync(scriptsDir);
  writeFileSync(join(scriptsDir, 'with-invoker-development-profile.mjs'), source, 'utf8');
  return repoRoot;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveActiveInvokerProfileEnv', () => {
  describe('when spawned by the production owner service', () => {
    const originalMarker = process.env.INVOKER_PRODUCTION_OWNER_SERVICE;

    beforeEach(() => {
      process.env.INVOKER_PRODUCTION_OWNER_SERVICE = '1';
    });

    afterEach(() => {
      if (originalMarker === undefined) delete process.env.INVOKER_PRODUCTION_OWNER_SERVICE;
      else process.env.INVOKER_PRODUCTION_OWNER_SERVICE = originalMarker;
    });

    it('skips dev-profile detection even on a git-checkout source root', () => {
      const repoRoot = resolveRepoRoot(process.cwd());

      const actual = resolveActiveInvokerProfileEnv({ repoRoot });

      expect(actual).toEqual({ INVOKER_RUNTIME_KIND: 'packaged', INVOKER_PRODUCTION_OWNER_SERVICE: '1' });
      expect(actual.INVOKER_DEVELOPMENT_PROFILE).toBeUndefined();
    });

    it('resolves the plain production socket path, not a dev-profile one', () => {
      const repoRoot = resolveRepoRoot(process.cwd());
      const profileEnv = resolveActiveInvokerProfileEnv({ repoRoot });
      const socketPath = resolveInvokerIpcSocketPath(profileEnv);

      expect(socketPath).not.toContain('/dev/');
      expect(socketPath.endsWith('/.invoker/ipc-transport.sock')).toBe(true);
    });
  });

  it('matches the development profile script for this repository', () => {
    const repoRoot = resolveRepoRoot(process.cwd());
    const scriptPath = join(repoRoot, 'scripts', 'with-invoker-development-profile.mjs');
    const direct = spawnSync(
      process.execPath,
      [scriptPath, '--source-root', repoRoot, '--print-env'],
      { encoding: 'utf8', timeout: 5_000 },
    );

    expect(direct.error).toBeUndefined();
    expect(direct.status).toBe(0);

    const expected = JSON.parse(direct.stdout) as Record<string, string>;
    const actual = resolveActiveInvokerProfileEnv({ repoRoot });

    expect(actual).toEqual(expected);
    expect(actual.INVOKER_DB_DIR).toBeTruthy();
    expect(actual.INVOKER_IPC_SOCKET).toBeTruthy();
  });

  it('returns an empty object when the profile script is absent', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'invoker-profile-env-missing-'));
    tempDirs.push(repoRoot);

    expect(() => resolveActiveInvokerProfileEnv({ repoRoot })).not.toThrow();
    expect(resolveActiveInvokerProfileEnv({ repoRoot })).toEqual({});
  });

  it.each([
    ['a non-zero exit', 'process.exit(2);'],
    ['empty output', ''],
    ['malformed JSON', "process.stdout.write('not-json');"],
    ['a non-object JSON value', "process.stdout.write('[]');"],
  ])('returns an empty object for %s', (_name, source) => {
    const repoRoot = makeRepoWithProfileScript(source);

    expect(resolveActiveInvokerProfileEnv({ repoRoot })).toEqual({});
  });

  it('returns an empty object when the subprocess times out', () => {
    const repoRoot = makeRepoWithProfileScript(
      "setTimeout(() => process.stdout.write('{}'), 1_000);",
    );

    expect(() => resolveActiveInvokerProfileEnv({ repoRoot, timeoutMs: 10 })).not.toThrow();
    expect(resolveActiveInvokerProfileEnv({ repoRoot, timeoutMs: 10 })).toEqual({});
  });
});
