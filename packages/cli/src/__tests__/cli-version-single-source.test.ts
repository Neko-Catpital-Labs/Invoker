import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { main as runtimeMain } from '../cli-runtime.js';

const packageRoot = resolve(__dirname, '../..');
const packageVersion = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')).version as string;
const indexVersion = readFileSync(resolve(__dirname, '../index.ts'), 'utf8').match(/^const VERSION = '([^']+)';$/m)?.[1];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('invoker-cli version', () => {
  it('prints the entry point version from the runtime --version path', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    const code = await runtimeMain(['--version', '--json'], {});

    expect(indexVersion).toBeTruthy();
    expect(code).toBe(0);
    expect(writes.join('')).toBe(`${indexVersion}\n`);
  });

  it('builds a dist entry whose --version fast path prints the package version', () => {
    const write = spawnSync(process.execPath, [resolve(packageRoot, 'scripts/write-dist-bin.cjs')], { encoding: 'utf8', timeout: 15_000 });
    expect(write.status, write.stderr).toBe(0);

    const run = spawnSync(process.execPath, [resolve(packageRoot, 'dist/index.js'), '--version'], { encoding: 'utf8', timeout: 15_000 });

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe(`${packageVersion}\n`);
    expect(indexVersion).toBe(packageVersion);
  });
});
