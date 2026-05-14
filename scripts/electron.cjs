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

function getElectronPlatformPath() {
  const platform = process.env.npm_config_platform || process.platform;

  switch (platform) {
    case 'mas':
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron';
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return 'electron';
    case 'win32':
      return 'electron.exe';
    default:
      throw new Error(`Electron builds are not available on platform: ${platform}`);
  }
}

async function repairElectronWithSystemUnzip(electronPackageDir) {
  if (process.env.ELECTRON_OVERRIDE_DIST_PATH) {
    return null;
  }

  const electronPackage = require(path.join(electronPackageDir, 'package.json'));
  const electronGetPath = require.resolve('@electron/get', {
    paths: [electronPackageDir],
  });
  const { downloadArtifact } = require(electronGetPath);
  const platformPath = getElectronPlatformPath();
  const platform = process.env.npm_config_platform || process.platform;
  const arch = process.env.npm_config_arch || process.arch;
  const zipPath = await downloadArtifact({
    version: electronPackage.version,
    artifactName: 'electron',
    force: process.env.force_no_cache === 'true',
    cacheRoot: process.env.electron_config_cache,
    checksums: process.env.electron_use_remote_checksums ?? process.env.npm_config_electron_use_remote_checksums
      ? undefined
      : require(path.join(electronPackageDir, 'checksums.json')),
    platform,
    arch,
  });

  const distPath = path.join(electronPackageDir, 'dist');
  fs.rmSync(distPath, { recursive: true, force: true });
  fs.mkdirSync(distPath, { recursive: true });

  const unzip = spawnSync('unzip', ['-q', '-o', zipPath, '-d', distPath], {
    cwd: electronPackageDir,
    env: process.env,
    stdio: 'inherit',
  });
  if (unzip.status !== 0) {
    return null;
  }
  if (unzip.signal) {
    process.kill(process.pid, unzip.signal);
    return null;
  }

  const sourceTypeDefinitions = path.join(distPath, 'electron.d.ts');
  if (fs.existsSync(sourceTypeDefinitions)) {
    fs.renameSync(sourceTypeDefinitions, path.join(electronPackageDir, 'electron.d.ts'));
  }
  fs.writeFileSync(path.join(electronPackageDir, 'path.txt'), platformPath);
  return resolveInstalledElectronBinary(electronPackageDir);
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
    return repairElectronWithSystemUnzip(electronPackageDir).then((fallbackBinary) => {
      if (!fallbackBinary) {
        console.error(
          'Electron is still unavailable after running its installer. ' +
          'If your environment blocks dependency build scripts, run `pnpm approve-builds` or reinstall with network access.',
        );
        process.exit(1);
      }

      return fallbackBinary;
    });
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
  Promise.resolve(ensureElectronInstalled()).then((binaryPath) => {
    if (!binaryPath) {
      process.exit(1);
    }

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
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

main();
