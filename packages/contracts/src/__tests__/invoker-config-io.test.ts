import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  INVOKER_CONFIG_FILE_MODE,
  invokerConfigBackupPath,
  readInvokerConfigFile,
  updateInvokerConfigFile,
  writeInvokerConfigFile,
} from '../invoker-config-io.js';

const tempRoots: string[] = [];

function makeConfigPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'invoker-config-io-'));
  tempRoots.push(root);
  return join(root, 'config.json');
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true });
  }
});

describe('Invoker config file IO', () => {
  it('treats a missing config file as an empty object', () => {
    expect(readInvokerConfigFile(makeConfigPath())).toEqual({});
  });

  it('creates parent directories when writing', () => {
    const configPath = join(mkdtempSync(join(tmpdir(), 'invoker-config-io-')), 'nested', 'config.json');
    tempRoots.push(join(configPath, '..', '..'));
    writeInvokerConfigFile(configPath, { maxConcurrency: 4 });
    expect(readInvokerConfigFile(configPath)).toEqual({ maxConcurrency: 4 });
  });

  it('preserves keys it does not recognize', () => {
    const configPath = makeConfigPath();
    writeFileSync(configPath, JSON.stringify({ futureKey: { nested: true }, experimentalPlanner: false }));

    updateInvokerConfigFile(configPath, (config) => {
      config.experimentalPlanner = true;
    });

    expect(readInvokerConfigFile(configPath)).toEqual({
      futureKey: { nested: true },
      experimentalPlanner: true,
    });
  });

  it('writes the config file with owner-only permissions', () => {
    const configPath = makeConfigPath();
    writeInvokerConfigFile(configPath, { webToken: 'secret' });
    expect(statSync(configPath).mode & 0o777).toBe(INVOKER_CONFIG_FILE_MODE);
  });

  it('tightens permissions on a config file that was previously world-readable', () => {
    const configPath = makeConfigPath();
    writeFileSync(configPath, JSON.stringify({ webToken: 'secret' }));
    chmodSync(configPath, 0o644);

    updateInvokerConfigFile(configPath, (config) => {
      config.webPort = 4200;
    });

    expect(statSync(configPath).mode & 0o777).toBe(INVOKER_CONFIG_FILE_MODE);
  });

  it('backs up the previous config and keeps the backup owner-only', () => {
    const configPath = makeConfigPath();
    writeFileSync(configPath, JSON.stringify({ webToken: 'original' }));
    chmodSync(configPath, 0o644);

    updateInvokerConfigFile(configPath, (config) => {
      config.webToken = 'rotated';
    });

    const backupPath = invokerConfigBackupPath(configPath);
    expect(JSON.parse(readFileSync(backupPath, 'utf8'))).toEqual({ webToken: 'original' });
    expect(statSync(backupPath).mode & 0o777).toBe(INVOKER_CONFIG_FILE_MODE);
  });

  it('does not write a backup on first creation', () => {
    const configPath = makeConfigPath();
    writeInvokerConfigFile(configPath, { maxConcurrency: 2 });
    expect(existsSync(invokerConfigBackupPath(configPath))).toBe(false);
  });

  it('leaves the existing config intact when serialization fails', () => {
    const configPath = makeConfigPath();
    writeFileSync(configPath, JSON.stringify({ maxConcurrency: 2 }));

    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => writeInvokerConfigFile(configPath, circular)).toThrow();
    expect(readInvokerConfigFile(configPath)).toEqual({ maxConcurrency: 2 });
  });

  it('does not leave temporary files behind after a failed write', () => {
    const configPath = makeConfigPath();
    writeFileSync(configPath, JSON.stringify({ maxConcurrency: 2 }));

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => writeInvokerConfigFile(configPath, circular)).toThrow();

    const siblings = readdirSync(join(configPath, '..'));
    expect(siblings.filter((entry) => entry.endsWith('.config.tmp'))).toEqual([]);
  });

  it('rejects a config file that is not a JSON object', () => {
    const configPath = makeConfigPath();
    writeFileSync(configPath, JSON.stringify([1, 2, 3]));
    expect(() => readInvokerConfigFile(configPath)).toThrow(/expected a JSON object/);
  });

  it('reports the path when the config file is malformed JSON', () => {
    const configPath = makeConfigPath();
    writeFileSync(configPath, '{ not json');
    expect(() => readInvokerConfigFile(configPath)).toThrow(new RegExp(configPath.replace(/[/\\]/g, '.')));
  });
});
