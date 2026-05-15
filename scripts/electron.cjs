#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const MISSING_ELECTRON_MESSAGE =
  'Electron is not installed. Provision this machine before running Invoker: ' +
  'run pnpm install with network access and approved Electron build scripts.';

function resolveElectronPackageDir() {
  let electronPackageJson;
  try {
    electronPackageJson = require.resolve('electron/package.json', {
      paths: [
        path.join(repoRoot, 'packages', 'app'),
        repoRoot,
      ],
    });
  } catch {
    return null;
  }
  return path.dirname(electronPackageJson);
}

function resolveInstalledElectronBinary(electronPackageDir) {
  if (!electronPackageDir) {
    return null;
  }

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

function getElectronBinaryOrExit() {
  const electronPackageDir = resolveElectronPackageDir();
  const existingBinary = resolveInstalledElectronBinary(electronPackageDir);
  if (existingBinary) {
    return existingBinary;
  }

  console.error(MISSING_ELECTRON_MESSAGE);
  process.exit(1);
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
  const binaryPath = getElectronBinaryOrExit();

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
