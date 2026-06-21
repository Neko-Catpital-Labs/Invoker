#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const ELECTRON_INSTALL_ATTEMPTS = 3;
const MISSING_ELECTRON_MESSAGE =
  'Electron is not installed. Provision this machine before running Invoker: ' +
  'run pnpm install with network access and approved Electron build scripts.';

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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

async function installElectronOrExit() {
  const electronPackageDir = resolveElectronPackageDir();
  if (!electronPackageDir) {
    console.error('Electron package is not installed. Run pnpm install with network access.');
    process.exit(1);
  }

  const existingBinary = resolveInstalledElectronBinary(electronPackageDir);
  if (existingBinary) {
    return existingBinary;
  }

  const installScript = path.join(electronPackageDir, 'install.js');
  for (let attempt = 1; attempt <= ELECTRON_INSTALL_ATTEMPTS; attempt += 1) {
    const install = spawnSync(process.execPath, [installScript], {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
    });

    if (install.signal) {
      process.kill(process.pid, install.signal);
      return null;
    }
    if (install.status === 0) {
      break;
    }
    if (attempt === ELECTRON_INSTALL_ATTEMPTS) {
      process.exit(install.status ?? 1);
    }

    const delayMs = attempt * 1_000;
    console.warn(
      `Electron installer failed with exit code ${install.status ?? 1}; retrying in ${delayMs}ms ` +
      `(${attempt + 1}/${ELECTRON_INSTALL_ATTEMPTS})`,
    );
    sleepSync(delayMs);
  }

  const installedBinary = resolveInstalledElectronBinary(electronPackageDir);
  if (installedBinary) {
    return installedBinary;
  }

  const repairedBinary = await repairElectronWithSystemUnzip(electronPackageDir);
  if (!repairedBinary) {
    console.error(
      'Electron is still unavailable after running its installer. ' +
      'If your environment blocks dependency build scripts, run `pnpm approve-builds` or reinstall with network access.',
    );
    process.exit(1);
  }
  return repairedBinary;
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

function findElectronAppArgIndex(args) {
  return args.findIndex((arg) => arg && !arg.startsWith('-'));
}

function withUserDataDir(args) {
  const userDataDir = process.env.INVOKER_USER_DATA_DIR;
  if (!userDataDir) {
    return args;
  }
  if (args.some((arg) => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='))) {
    return args;
  }

  const appArgIndex = findElectronAppArgIndex(args);
  const userDataArg = `--user-data-dir=${userDataDir}`;
  if (appArgIndex === -1) {
    return [userDataArg, ...args];
  }
  return [...args.slice(0, appArgIndex), userDataArg, ...args.slice(appArgIndex)];
}

function withMacOSPersistenceIgnoreState(args) {
  if (process.platform !== 'darwin') {
    return args;
  }
  if (args.includes('-ApplePersistenceIgnoreState')) {
    return args;
  }

  // AppKit can show a blocking "reopen windows?" crash-recovery modal before
  // Electron runs our JS, which also stalls headless CLI invocations.
  //
  // Keep this native flag after Electron's app path; putting it before the
  // script prevents Electron from loading dist/main.js.
  const appArgIndex = findElectronAppArgIndex(args);
  const insertAt = appArgIndex >= 0 ? appArgIndex + 1 : args.length;
  return [...args.slice(0, insertAt), '-ApplePersistenceIgnoreState', 'YES', ...args.slice(insertAt)];
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 1 && args[0] === '--install-only') {
    await installElectronOrExit();
    return;
  }

  const binaryPath = getElectronBinaryOrExit();

  if (args.length === 1 && args[0] === '--ensure-only') {
    return;
  }

  const launchArgs = withMacOSPersistenceIgnoreState(withLinuxSandboxFallback(binaryPath, withUserDataDir(args)));
  const child = spawn(binaryPath, launchArgs, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  let childExited = false;
  const signalHandlers = new Map();

  const forwardSignal = (signal) => {
    if (childExited) {
      process.exit(0);
      return;
    }
    try {
      child.kill(signal);
    } catch {
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => forwardSignal(signal);
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  const removeSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    signalHandlers.clear();
  };

  child.once('error', (error) => {
    removeSignalHandlers();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
  child.once('exit', (code, signal) => {
    childExited = true;
    removeSignalHandlers();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
