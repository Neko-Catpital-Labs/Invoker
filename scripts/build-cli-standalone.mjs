#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = require(join(root, 'packages/cli/package.json'));
const nodeVersion = process.env.INVOKER_STANDALONE_NODE_VERSION ?? process.version.replace(/^v/, '');
const platform = process.env.INVOKER_TARGET_PLATFORM ?? process.platform;
const arch = process.env.INVOKER_TARGET_ARCH ?? process.arch;
const outDir = resolve(process.env.INVOKER_CLI_STANDALONE_DIR ?? join(root, 'release'));
const binaryName = `invoker-cli-${pkg.version}-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`;
const outPath = join(outDir, binaryName);

if (!['darwin', 'linux'].includes(platform)) {
  throw new Error(`Unsupported standalone CLI platform: ${platform}`);
}
if (!['x64', 'arm64'].includes(arch)) {
  throw new Error(`Unsupported standalone CLI architecture: ${arch}`);
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    ...options,
  });
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  await pipeline(response.body, createWriteStream(destination));
}

async function ensureTargetNode(stage) {
  if (process.env.INVOKER_USE_HOST_NODE_FOR_SEA === '1' && platform === process.platform && arch === process.arch) {
    return process.execPath;
  }

  const ext = platform === 'darwin' ? 'tar.gz' : 'tar.xz';
  const archiveBase = `node-v${nodeVersion}-${platform}-${arch}`;
  const archiveName = `${archiveBase}.${ext}`;
  const archivePath = join(stage, archiveName);
  const url = `https://nodejs.org/dist/v${nodeVersion}/${archiveName}`;
  await download(url, archivePath);
  run('tar', ['-xf', archivePath, '-C', stage]);
  return join(stage, archiveBase, 'bin', 'node');
}

async function sha256(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

await mkdir(outDir, { recursive: true });
const stage = await mkdtemp(join(tmpdir(), 'invoker-cli-sea-'));

try {
  const bundlePath = join(stage, 'index.js');
  const blobPath = join(stage, 'sea-prep.blob');
  const seaConfigPath = join(stage, 'sea-config.json');
  const standaloneEntryPath = join(stage, 'index.ts');
  const targetNode = await ensureTargetNode(stage);
  const cliEntryImportPath = join(root, 'packages/cli/src/index.ts').replaceAll('\\', '/');

  await writeFile(standaloneEntryPath, [
    `import { main } from ${JSON.stringify(cliEntryImportPath)};`,
    '',
    'void main().then((exitCode) => {',
    '  process.exitCode = exitCode;',
    '});',
    '',
  ].join('\n'));

  run('pnpm', [
    'exec',
    'tsup',
    standaloneEntryPath,
    '--format',
    'cjs',
    '--platform',
    'node',
    '--target',
    'node26',
    '--no-dts',
    '--no-splitting',
    '--no-config',
    '--out-dir',
    stage,
    '--external',
    'node:sqlite',
    '--external',
    'dockerode',
    '--external',
    'ssh2',
    '--external',
    'cpu-features',
  ]);

  await writeFile(seaConfigPath, JSON.stringify({
    main: bundlePath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
  }, null, 2));

  run(process.execPath, ['--experimental-sea-config', seaConfigPath]);
  await copyFile(targetNode, outPath);
  await chmod(outPath, 0o755);

  if (platform === 'darwin') {
    try {
      run('codesign', ['--remove-signature', outPath]);
    } catch {
      // Downloaded Node binaries are not always signed in local/dev builds.
    }
  }

  const postjectArgs = [
    outPath,
    'NODE_SEA_BLOB',
    blobPath,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ];
  if (platform === 'darwin') {
    postjectArgs.push('--macho-segment-name', 'NODE_SEA');
  }
  run('pnpm', ['exec', 'postject', ...postjectArgs]);

  if (platform === 'darwin') {
    try {
      run('codesign', ['--sign', '-', outPath]);
    } catch {
      // Ad-hoc signing is best-effort for local builds. Release runners have codesign.
    }
  }

  console.log(`${outPath}`);
  console.log(`${await sha256(outPath)}  ${basename(outPath)}`);
} finally {
  if (process.env.INVOKER_KEEP_STANDALONE_STAGE !== '1') {
    await rm(stage, { recursive: true, force: true });
  }
}
