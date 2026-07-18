import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const uiDir = resolve(repoRoot, 'packages/ui');
const vitestBin = resolve(uiDir, 'node_modules/.bin/vitest');
const vitestCommand = process.platform === 'win32' ? `${vitestBin}.cmd` : vitestBin;
const [, , ...rawArgs] = process.argv;
const forwardedArgs = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;

if (!existsSync(vitestCommand)) {
  console.error(`Vitest binary not found at ${vitestCommand}. Run pnpm install first.`);
  process.exit(127);
}

const child = spawn(vitestCommand, ['run', ...forwardedArgs], {
  cwd: uiDir,
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
