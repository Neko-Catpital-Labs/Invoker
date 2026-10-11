import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ZSHRC_ONLY = 'INVOKER_REPRO_FROM_ZSHRC';
const OWNER_WINS = 'INVOKER_REPRO_OWNER_WINS';
const ZSHRC_VALUE = 'from-zshrc';
const OWNER_VALUE = 'from-owner';
const PATH_SENTINEL = '/tmp/invoker-repro-bin-sentinel';

async function readBashVar(name: string, env: NodeJS.ProcessEnv): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['-c', `printf %s "$${name}"`], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`bash -c exited ${code ?? 'null'}`));
    });
  });
}

describe('login shell exports reach command tasks', () => {
  let zdotdir: string | undefined;
  let originalPath: string | undefined;
  let originalShell: string | undefined;
  let originalZdotdir: string | undefined;
  let originalOwnerWins: string | undefined;

  afterEach(async () => {
    const { resetShellEnvironmentForTests } = await import('../process-utils.js');
    resetShellEnvironmentForTests();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
    if (originalZdotdir === undefined) delete process.env.ZDOTDIR;
    else process.env.ZDOTDIR = originalZdotdir;
    if (originalOwnerWins === undefined) delete process.env[OWNER_WINS];
    else process.env[OWNER_WINS] = originalOwnerWins;
    delete process.env[ZSHRC_ONLY];
    if (zdotdir) rmSync(zdotdir, { recursive: true, force: true });
    zdotdir = undefined;
  });

  it.skipIf(process.platform !== 'darwin')(
    'gives bash -c a zshrc export that was absent from the owner',
    async () => {
      zdotdir = mkdtempSync(join(tmpdir(), 'invoker-shell-env-'));
      writeFileSync(join(zdotdir, '.zshenv'), '');
      writeFileSync(join(zdotdir, '.zprofile'), '');
      writeFileSync(join(zdotdir, '.zlogin'), '');
      writeFileSync(
        join(zdotdir, '.zshrc'),
        [
          `export ${ZSHRC_ONLY}=${ZSHRC_VALUE}`,
          `export ${OWNER_WINS}=from-shell`,
          `export PATH="$PATH:${PATH_SENTINEL}"`,
          '',
        ].join('\n'),
      );

      originalPath = process.env.PATH;
      originalShell = process.env.SHELL;
      originalZdotdir = process.env.ZDOTDIR;
      originalOwnerWins = process.env[OWNER_WINS];
      delete process.env[ZSHRC_ONLY];
      process.env.SHELL = '/bin/zsh';
      process.env.ZDOTDIR = zdotdir;
      process.env[OWNER_WINS] = OWNER_VALUE;

      const { initializeShellEnvironment, cleanElectronEnv, resetShellEnvironmentForTests } = await import('../process-utils.js');
      resetShellEnvironmentForTests();
      const result = await initializeShellEnvironment();

      expect(result.status).toBe('resolved');
      expect(result.path).toContain(PATH_SENTINEL);
      expect(process.env[ZSHRC_ONLY]).toBe(ZSHRC_VALUE);
      expect(process.env[OWNER_WINS]).toBe(OWNER_VALUE);

      const childEnv = cleanElectronEnv();
      expect(await readBashVar(ZSHRC_ONLY, childEnv)).toBe(ZSHRC_VALUE);
      expect(await readBashVar(OWNER_WINS, childEnv)).toBe(OWNER_VALUE);
    },
  );
});
