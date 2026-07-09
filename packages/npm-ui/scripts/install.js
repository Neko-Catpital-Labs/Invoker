#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = require(join(root, 'package.json'));

if (existsSync(join(root, '..', '..', 'pnpm-workspace.yaml'))) {
  process.exit(0);
}

const repo = process.env.INVOKER_RELEASE_REPOSITORY ?? 'Neko-Catpital-Labs/Invoker';
const baseUrl = process.env.INVOKER_RELEASE_BASE_URL ?? `https://github.com/${repo}/releases/download/v${pkg.version}`;
const vendor = join(root, 'vendor');

const arch = process.arch;
const linuxAssetArch = arch === 'x64' ? 'x86_64' : arch;
const asset = process.platform === 'darwin'
  ? `Invoker-${pkg.version}-${arch}.zip`
  : process.platform === 'linux'
    ? `Invoker-${pkg.version}-${linuxAssetArch}.AppImage`
    : undefined;

if (!asset) {
  throw new Error(`Unsupported Invoker UI platform: ${process.platform}-${process.arch}`);
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  await pipeline(response.body, createWriteStream(destination));
}

async function sha256(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

function expectedHash(sums, name) {
  for (const line of sums.split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match && match[2].trim() === name) return match[1].toLowerCase();
  }
  return undefined;
}

await mkdir(vendor, { recursive: true });
await download(`${baseUrl}/SHA256SUMS`, join(vendor, 'SHA256SUMS'));
await download(`${baseUrl}/${asset}`, join(vendor, asset));

const sums = await readFile(join(vendor, 'SHA256SUMS'), 'utf8');
const expected = expectedHash(sums, asset);
if (!expected) throw new Error(`SHA256SUMS does not contain ${asset}`);
const actual = await sha256(join(vendor, asset));
if (actual !== expected) {
  throw new Error(`Checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
}

if (process.platform === 'darwin') {
  await rm(join(vendor, 'Invoker.app'), { recursive: true, force: true });
  execFileSync('unzip', ['-q', asset], { cwd: vendor, stdio: 'inherit' });
  if (!existsSync(join(vendor, 'Invoker.app'))) {
    throw new Error(`${asset} did not contain Invoker.app`);
  }
} else {
  const target = join(vendor, 'Invoker.AppImage');
  await rm(target, { force: true });
  execFileSync('cp', [join(vendor, asset), target]);
  await chmod(target, 0o755);
}
