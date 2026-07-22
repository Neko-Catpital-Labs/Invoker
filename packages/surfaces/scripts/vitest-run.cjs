#!/usr/bin/env node

const { spawn, spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { dirname, resolve } = require('node:path');

const args = process.argv.slice(2);
const passthroughArgs = args[0] === '--' ? args.slice(1) : args;
const packageDir = resolve(__dirname, '..');
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function findWorkspaceRoot(startDir) {
  let current = startDir;
  while (true) {
    if (existsSync(resolve(current, 'pnpm-lock.yaml'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function readPackageName() {
  const manifestPath = resolve(packageDir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    throw new Error(`Package manifest at ${manifestPath} does not define a package name`);
  }
  return manifest.name;
}

function runPnpmSync(args, options = {}) {
  return spawnSync(pnpmCommand, args, {
    cwd: options.cwd ?? packageDir,
    stdio: options.stdio ?? 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });
}

function canRunVitest() {
  const result = runPnpmSync(['exec', 'vitest', '--version'], { stdio: 'ignore' });
  return result.status === 0;
}

function ensureVitestAvailable() {
  if (canRunVitest()) return;

  const workspaceRoot = findWorkspaceRoot(packageDir);
  if (!workspaceRoot) {
    console.error('Failed to start vitest: could not find pnpm workspace root');
    process.exit(1);
  }

  let packageName;
  try {
    packageName = readPackageName();
  } catch (error) {
    console.error(`Failed to start vitest: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  console.log(`Vitest binary is unavailable; installing filtered workspace dependencies for ${packageName}`);
  const install = runPnpmSync(
    ['--filter', `${packageName}...`, 'install', '--frozen-lockfile', '--ignore-scripts', '--prod=false'],
    { cwd: workspaceRoot },
  );
  if (install.error) {
    console.error(`Failed to install filtered workspace dependencies: ${install.error.message}`);
    process.exit(1);
  }
  if ((install.status ?? 1) !== 0) {
    process.exit(install.status ?? 1);
  }

  if (!canRunVitest()) {
    console.error(`Failed to start vitest: binary is still unavailable after filtered install for ${packageName}`);
    process.exit(1);
  }
}

ensureVitestAvailable();

const child = spawn(pnpmCommand, ['exec', 'vitest', 'run', ...passthroughArgs], {
  cwd: packageDir,
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
});

child.on('error', (error) => {
  console.error(`Failed to start vitest: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
