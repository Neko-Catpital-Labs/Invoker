#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const ELECTRON_INSTALL_ATTEMPTS = 3;
const MISSING_ELECTRON_MESSAGE =
  'Electron is not installed. Provision this machine before running Invoker: ' +
  'run pnpm install with network access and approved Electron build scripts.';

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_UNIX_IFMT = 61440;
const ZIP_UNIX_IFDIR = 16384;
const ZIP_UNIX_IFLNK = 40960;

function readZipCentralDirectory(fd, fileSize) {
  const searchSize = Math.min(fileSize, 65557);
  const tail = Buffer.alloc(searchSize);
  fs.readSync(fd, tail, 0, searchSize, fileSize - searchSize);

  let eocdOffset = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('End of central directory record not found in zip archive');
  }

  const numEntries = tail.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = tail.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = tail.readUInt32LE(eocdOffset + 16);
  if (numEntries === 0xffff || centralDirectoryOffset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported by the fallback extractor');
  }

  const centralDirBuffer = Buffer.alloc(centralDirectorySize);
  fs.readSync(fd, centralDirBuffer, 0, centralDirectorySize, centralDirectoryOffset);

  const entries = [];
  let offset = 0;
  for (let i = 0; i < numEntries; i += 1) {
    if (centralDirBuffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(`Invalid central directory entry signature at index ${i}`);
    }
    const versionMadeBy = centralDirBuffer.readUInt16LE(offset + 4);
    const compressionMethod = centralDirBuffer.readUInt16LE(offset + 10);
    const compressedSize = centralDirBuffer.readUInt32LE(offset + 20);
    const uncompressedSize = centralDirBuffer.readUInt32LE(offset + 24);
    const fileNameLength = centralDirBuffer.readUInt16LE(offset + 28);
    const extraFieldLength = centralDirBuffer.readUInt16LE(offset + 30);
    const fileCommentLength = centralDirBuffer.readUInt16LE(offset + 32);
    const externalFileAttributes = centralDirBuffer.readUInt32LE(offset + 38);
    const relativeOffsetOfLocalHeader = centralDirBuffer.readUInt32LE(offset + 42);
    const fileNameStart = offset + 46;
    const fileName = centralDirBuffer.toString('utf8', fileNameStart, fileNameStart + fileNameLength);

    entries.push({
      versionMadeBy,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      externalFileAttributes,
      relativeOffsetOfLocalHeader,
      fileName,
    });

    offset = fileNameStart + fileNameLength + extraFieldLength + fileCommentLength;
  }
  return entries;
}

function readZipEntryDataStart(fd, entry) {
  const header = Buffer.alloc(30);
  fs.readSync(fd, header, 0, 30, entry.relativeOffsetOfLocalHeader);
  if (header.readUInt32LE(0) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(`Invalid local file header signature for ${entry.fileName}`);
  }
  const fileNameLength = header.readUInt16LE(26);
  const extraFieldLength = header.readUInt16LE(28);
  return entry.relativeOffsetOfLocalHeader + 30 + fileNameLength + extraFieldLength;
}

function extractZipEntrySync(fd, entry, destDir) {
  const unixMode = (entry.externalFileAttributes >> 16) & 0xffff;
  const symlink = (unixMode & ZIP_UNIX_IFMT) === ZIP_UNIX_IFLNK;
  let isDir = (unixMode & ZIP_UNIX_IFMT) === ZIP_UNIX_IFDIR;
  if (!isDir && entry.fileName.endsWith('/')) {
    isDir = true;
  }
  const madeBy = entry.versionMadeBy >> 8;
  if (!isDir && madeBy === 0 && entry.externalFileAttributes === 16) {
    isDir = true;
  }

  const destPath = path.join(destDir, entry.fileName);
  const canonicalDestDir = path.resolve(isDir ? destPath : path.dirname(destPath));
  const relativeDestDir = path.relative(destDir, canonicalDestDir);
  if (relativeDestDir.split(path.sep).includes('..')) {
    throw new Error(`Out of bound path "${canonicalDestDir}" found while processing file ${entry.fileName}`);
  }

  if (isDir) {
    fs.mkdirSync(destPath, { recursive: true, mode: (unixMode & 0o777) || 0o755 });
    return;
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  let data = Buffer.alloc(0);
  if (entry.compressedSize > 0) {
    const dataStart = readZipEntryDataStart(fd, entry);
    const compressed = Buffer.alloc(entry.compressedSize);
    fs.readSync(fd, compressed, 0, entry.compressedSize, dataStart);
    if (entry.compressionMethod === 0) {
      data = compressed;
    } else if (entry.compressionMethod === 8) {
      data = zlib.inflateRawSync(compressed);
    } else {
      throw new Error(`Unsupported compression method ${entry.compressionMethod} for ${entry.fileName}`);
    }
  }

  if (symlink) {
    fs.symlinkSync(data.toString('utf8'), destPath);
    return;
  }

  fs.writeFileSync(destPath, data, { mode: (unixMode & 0o777) || 0o644 });
}

function extractZipSync(zipPath, destDir) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const entries = readZipCentralDirectory(fd, fileSize);
    fs.mkdirSync(destDir, { recursive: true });
    for (const entry of entries) {
      if (entry.fileName.startsWith('__MACOSX/')) {
        continue;
      }
      extractZipEntrySync(fd, entry, destDir);
    }
  } finally {
    fs.closeSync(fd);
  }
}

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

async function repairElectronWithPackageExtractor(electronPackageDir) {
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
  const stagingPath = path.join(electronPackageDir, `dist.staging-${process.pid}`);
  fs.rmSync(stagingPath, { recursive: true, force: true });
  fs.mkdirSync(stagingPath, { recursive: true });
  try {
    extractZipSync(zipPath, stagingPath);

    const stagedBinary = path.join(stagingPath, platformPath);
    if (!fs.existsSync(stagedBinary)) {
      throw new Error(`Zip extraction did not produce ${platformPath} in ${stagingPath}; extraction was interrupted or incomplete`);
    }

    fs.rmSync(distPath, { recursive: true, force: true });
    fs.renameSync(stagingPath, distPath);
  } catch (error) {
    fs.rmSync(stagingPath, { recursive: true, force: true });
    throw error;
  }

  const sourceTypeDefinitions = path.join(distPath, 'electron.d.ts');
  if (fs.existsSync(sourceTypeDefinitions)) {
    fs.renameSync(sourceTypeDefinitions, path.join(electronPackageDir, 'electron.d.ts'));
  }
  fs.writeFileSync(path.join(electronPackageDir, 'path.txt'), platformPath);
  return resolveInstalledElectronBinary(electronPackageDir);
}

async function installElectronOrExit() {
  if (process.env.INVOKER_SKIP_ELECTRON_INSTALL === '1') {
    return null;
  }

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

  const repairedBinary = await repairElectronWithPackageExtractor(electronPackageDir);
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
  // Keep Electron's app path as argv[1]; putting this flag before the script
  // prevents Electron from loading dist/main.js.
  const insertAt = args.length > 0 ? 1 : 0;
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

  const launchArgs = withMacOSPersistenceIgnoreState(withLinuxSandboxFallback(binaryPath, args));
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
