#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

function resolveElectronPackageDir() {
  const electronPackageJson = require.resolve('electron/package.json', {
    paths: [
      path.join(repoRoot, 'packages', 'app'),
      repoRoot,
    ],
  });
  return path.dirname(electronPackageJson);
}

function resolveInstalledElectronBinary(electronPackageDir) {
  const pathFile = path.join(electronPackageDir, 'path.txt');
  if (!fs.existsSync(pathFile)) {
    return null;
  }

  const executablePath = fs.readFileSync(pathFile, 'utf8').trim();
  if (!executablePath) {
    return null;
  }

  const overrideDistPath = process.env.ELECTRON_OVERRIDE_DIST_PATH;
  const distRoot = overrideDistPath || path.join(electronPackageDir, 'dist');
  const binaryPath = path.join(distRoot, executablePath);
  return fs.existsSync(binaryPath) ? binaryPath : null;
}

function ensureElectronInstalled() {
  const electronPackageDir = resolveElectronPackageDir();
  const existingBinary = resolveInstalledElectronBinary(electronPackageDir);
  if (existingBinary) {
    return existingBinary;
  }

  const installScript = path.join(electronPackageDir, 'install.js');
  const install = spawnSync(process.execPath, [installScript], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });

  if (install.status !== 0) {
    process.exit(install.status ?? 1);
  }
  if (install.signal) {
    process.kill(process.pid, install.signal);
    return null;
  }

  const repairedBinary = resolveInstalledElectronBinary(electronPackageDir);
  if (!repairedBinary) {
    console.error(
      'Electron is still unavailable after running its installer. ' +
      'If your environment blocks dependency build scripts, run `pnpm approve-builds` or reinstall with network access.',
    );
    process.exit(1);
  }

  return repairedBinary;
}

function withLinuxSandboxFallback(binaryPath, args) {
  if (process.platform !== 'linux' || args.includes('--no-sandbox')) {
    return args;
  }

  const sandboxPath = path.join(path.dirname(binaryPath), 'chrome-sandbox');
  try {
    const stats = fs.statSync(sandboxPath);
    if (stats.uid === 0 && (stats.mode & 0o7777) === 0o4755) {
      return args;
    }
  } catch {
    return ['--no-sandbox', ...args];
  }

  return ['--no-sandbox', ...args];
}

function main() {
  const args = process.argv.slice(2);
  const binaryPath = ensureElectronInstalled();

  if (args.length === 1 && args[0] === '--ensure-only') {
    return;
  }

  const launchArgs = withLinuxSandboxFallback(binaryPath, args);
  const child = spawn(binaryPath, launchArgs, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  child.once('error', (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
  child.once('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main();
