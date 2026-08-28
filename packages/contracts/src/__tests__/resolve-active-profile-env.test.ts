import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveActiveInvokerProfileEnv, resolveRepoRoot } from '../index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'invoker-active-profile-env-'));
  tempDirs.push(root);
  return root;
}

function makeProfileScript(source: string): string {
  const root = makeTempRoot();
  const scriptsDir = join(root, 'scripts');
  mkdirSync(scriptsDir);
  writeFileSync(join(scriptsDir, 'with-invoker-development-profile.mjs'), source, 'utf8');
  return root;
}

describe('resolveActiveInvokerProfileEnv', () => {
  it('matches the profile script print-only mode for this repository', () => {
    const repoRoot = resolveRepoRoot(process.cwd());
    const direct = spawnSync(
      process.execPath,
      [
        join(repoRoot, 'scripts', 'with-invoker-development-profile.mjs'),
        '--source-root',
        repoRoot,
        '--print-env',
      ],
      { encoding: 'utf8', timeout: 5_000 },
    );

    expect(direct.status).toBe(0);
    const expected = JSON.parse(direct.stdout) as Record<string, string>;
    const resolved = resolveActiveInvokerProfileEnv({ repoRoot });

    expect(resolved.INVOKER_DB_DIR).toBeTruthy();
    expect(resolved.INVOKER_IPC_SOCKET).toBeTruthy();
    expect(resolved).toEqual(expected);
  });

  it('uses the resolved repository root by default', () => {
    expect(resolveActiveInvokerProfileEnv()).toEqual(
      resolveActiveInvokerProfileEnv({ repoRoot: resolveRepoRoot(process.cwd()) }),
    );
  });

  it('returns an empty object when the profile script is missing', () => {
    expect(resolveActiveInvokerProfileEnv({ repoRoot: makeTempRoot() })).toEqual({});
  });

  it.each([
    ['a non-zero exit', 'process.exit(2);'],
    ['empty output', ''],
    ['malformed JSON', "process.stdout.write('not-json');"],
    ['JSON that is not an environment object', "process.stdout.write('[]');"],
  ])('returns an empty object for %s', (_failure, source) => {
    expect(resolveActiveInvokerProfileEnv({ repoRoot: makeProfileScript(source) })).toEqual({});
  });

  it('returns an empty object when the subprocess times out', () => {
    const repoRoot = makeProfileScript('setInterval(() => {}, 1_000);');

    expect(resolveActiveInvokerProfileEnv({ repoRoot, timeoutMs: 25 })).toEqual({});
  });
});
