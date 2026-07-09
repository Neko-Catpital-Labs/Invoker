import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertBundledCliAvailable, resolveBundledCliPath, spawnBundledCli } from '../cli-helper.js';

describe('CLI helper packaging', () => {
  it('resolves the packaged CLI from Electron resources', () => {
    const resourcesPath = join(tmpdir(), 'Invoker.app', 'Contents', 'Resources');
    expect(resolveBundledCliPath({ isPackaged: true, resourcesPath }))
      .toBe(join(resourcesPath, 'invoker-cli', 'invoker-cli'));
  });

  it('resolves the development workspace CLI path without PATH lookup', () => {
    const appDir = '/repo/packages/app';
    expect(resolveBundledCliPath({ isPackaged: false, appDir }))
      .toBe('/repo/packages/cli/dist/index.js');
  });

  it('verifies packaged resources include the CLI helper', () => {
    const root = mkdtempSync(join(tmpdir(), 'invoker-cli-helper-'));
    const cliPath = join(root, 'invoker-cli', 'dist', 'index.js');
    mkdirSync(join(root, 'invoker-cli', 'dist'), { recursive: true });
    writeFileSync(cliPath, '#!/usr/bin/env node\n', 'utf8');
    expect(() => assertBundledCliAvailable(cliPath)).not.toThrow();
  });

  it('spawns the helper by absolute path with explicit runtime paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'invoker-cli-spawn-'));
    const cliPath = join(root, 'invoker-cli', 'dist', 'index.js');
    mkdirSync(join(root, 'invoker-cli', 'dist'), { recursive: true });
    writeFileSync(cliPath, 'console.log(JSON.stringify(process.argv.slice(2)))\n', 'utf8');

    const child = spawnBundledCli(cliPath, ['run', 'plan.yaml'], {
      dbDir: join(root, 'db'),
      configPath: join(root, 'config.json'),
    });
    const stdout = await new Promise<string>((resolve) => {
      let value = '';
      child.stdout?.on('data', (chunk) => { value += chunk.toString(); });
      child.on('close', () => resolve(value));
    });
    expect(JSON.parse(stdout)).toEqual([
      'run',
      'plan.yaml',
      '--db-dir',
      join(root, 'db'),
      '--config',
      join(root, 'config.json'),
    ]);
  });

  it('spawns a packaged standalone helper directly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'invoker-cli-packaged-spawn-'));
    const cliPath = join(root, 'invoker-cli');
    writeFileSync(cliPath, '#!/usr/bin/env sh\nprintf "%s\\n" "$1"\n', { encoding: 'utf8', mode: 0o755 });

    const child = spawnBundledCli(cliPath, ['--version']);
    const stdout = await new Promise<string>((resolve) => {
      let value = '';
      child.stdout?.on('data', (chunk) => { value += chunk.toString(); });
      child.on('close', () => resolve(value));
    });
    expect(stdout.trim()).toBe('--version');
  });
});
