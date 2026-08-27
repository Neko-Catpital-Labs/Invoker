import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  addAutoApproveAuthor,
  applyAutoApproveAuthorsAction,
  readAutoApproveAuthors,
  writeAutoApproveAuthors,
} from '../auto-approve-authors-config.js';
import { readInvokerConfigFile, writeInvokerConfigFile } from '@invoker/contracts';

const tempRoots: string[] = [];

function makeConfigPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'auto-approve-authors-config-'));
  tempRoots.push(root);
  return join(root, 'config.json');
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true });
  }
});

describe('auto-approve authors config', () => {
  it('treats a missing key as nobody', () => {
    const configPath = makeConfigPath();
    writeInvokerConfigFile(configPath, { autoApproveAIFixes: false });
    expect(readAutoApproveAuthors(readInvokerConfigFile(configPath))).toEqual({
      authors: [],
      allowlistOk: false,
      reason: 'missing',
    });
  });

  it('adds the current GitHub login without enabling the toggle', async () => {
    const configPath = makeConfigPath();
    writeInvokerConfigFile(configPath, { autoApproveAIFixes: false, maxConcurrency: 2 });
    const result = await applyAutoApproveAuthorsAction({
      configPath,
      action: 'add_current_github_user',
      lookupGithubLogin: async () => 'EdbertChan',
    });
    expect(result).toEqual({ authors: ['EdbertChan'], allowlistOk: true });
    const saved = readInvokerConfigFile(configPath);
    expect(saved.autoApproveAuthors).toEqual(['EdbertChan']);
    expect(saved.autoApproveAIFixes).toBe(false);
    expect(saved.maxConcurrency).toBe(2);
  });

  it('replaces and clears the list', async () => {
    const configPath = makeConfigPath();
    writeInvokerConfigFile(configPath, {});
    await applyAutoApproveAuthorsAction({
      configPath,
      action: 'set',
      authors: ['Alice', 'Bob'],
    });
    expect(readInvokerConfigFile(configPath).autoApproveAuthors).toEqual(['Alice', 'Bob']);
    await applyAutoApproveAuthorsAction({ configPath, action: 'clear' });
    expect(readInvokerConfigFile(configPath).autoApproveAuthors).toEqual([]);
  });

  it('fails closed when gh cannot resolve the current user', async () => {
    const configPath = makeConfigPath();
    writeInvokerConfigFile(configPath, {});
    await expect(applyAutoApproveAuthorsAction({
      configPath,
      action: 'add_current_github_user',
      lookupGithubLogin: async () => null,
    })).rejects.toThrow(/Could not read the current GitHub login/);
    expect(readInvokerConfigFile(configPath).autoApproveAuthors).toBeUndefined();
  });

  it('dedupes on add', () => {
    const config = {};
    writeAutoApproveAuthors(config, ['EdbertChan']);
    expect(addAutoApproveAuthor(config, 'edbertchan')).toEqual(['EdbertChan']);
  });
});
