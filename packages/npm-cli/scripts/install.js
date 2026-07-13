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
const asset = `invoker-cli-${pkg.version}-${process.platform}-${process.arch}.tar.gz`;
const vendor = join(root, 'vendor');
const archivePath = join(vendor, asset);
const sumsPath = join(vendor, 'SHA256SUMS');
const binaryPath = join(vendor, 'invoker-cli');

if (!['darwin', 'linux'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) {
  throw new Error(`Unsupported Invoker CLI platform: ${process.platform}-${process.arch}`);
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
await rm(binaryPath, { force: true });
await download(`${baseUrl}/SHA256SUMS`, sumsPath);
await download(`${baseUrl}/${asset}`, archivePath);

const sums = await readFile(sumsPath, 'utf8');
const expected = expectedHash(sums, asset);
if (!expected) {
  throw new Error(`SHA256SUMS does not contain ${asset}`);
}
const actual = await sha256(archivePath);
if (actual !== expected) {
  throw new Error(`Checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
}

execFileSync('tar', ['-xzf', archivePath, '-C', vendor], { stdio: 'inherit' });
const extracted = join(vendor, asset.replace(/\.tar\.gz$/, ''), 'invoker-cli');
if (!existsSync(extracted)) {
  throw new Error(`Downloaded archive did not contain ${extracted}`);
}
execFileSync('cp', [extracted, binaryPath]);
await chmod(binaryPath, 0o755);
