import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { systemUnzipIsAvailable, extractZipWithSystemUnzip } = require('./electron.cjs');

function withFakeUnzipOnPath(scriptBody) {
  const originalPath = process.env.PATH;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-unzip-'));
  const unzipPath = path.join(dir, 'unzip');
  fs.writeFileSync(unzipPath, scriptBody);
  fs.chmodSync(unzipPath, 0o755);
  process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
  return () => {
    process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
  };
}

function withNoUnzipOnPath() {
  const originalPath = process.env.PATH;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-unzip-'));
  process.env.PATH = dir;
  return () => {
    process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
  };
}

test('systemUnzipIsAvailable returns true when a fake unzip exits 0', () => {
  const cleanup = withFakeUnzipOnPath('#!/bin/sh\nexit 0\n');
  try {
    assert.equal(systemUnzipIsAvailable(), true);
  } finally {
    cleanup();
  }
});

test('systemUnzipIsAvailable returns false when PATH has no unzip', () => {
  const cleanup = withNoUnzipOnPath();
  try {
    assert.equal(systemUnzipIsAvailable(), false);
  } finally {
    cleanup();
  }
});

test('extractZipWithSystemUnzip returns true and writes the sentinel file', () => {
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unzip-dest-'));
  const sentinelName = 'sentinel.txt';
  const cleanup = withFakeUnzipOnPath(
    `#!/bin/sh\ndestDir="$5"\ntouch "$destDir/${sentinelName}"\nexit 0\n`,
  );
  try {
    const result = extractZipWithSystemUnzip('/fake/path.zip', destDir);
    assert.equal(result, true);
    assert.equal(fs.existsSync(path.join(destDir, sentinelName)), true);
  } finally {
    cleanup();
    fs.rmSync(destDir, { recursive: true, force: true });
  }
});

test('extractZipWithSystemUnzip returns false and writes nothing when PATH has no unzip', () => {
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unzip-dest-'));
  const cleanup = withNoUnzipOnPath();
  try {
    const result = extractZipWithSystemUnzip('/fake/path.zip', destDir);
    assert.equal(result, false);
    assert.deepEqual(fs.readdirSync(destDir), []);
  } finally {
    cleanup();
    fs.rmSync(destDir, { recursive: true, force: true });
  }
});
