#!/usr/bin/env node

/**
 * Upload images/videos to Cloudflare R2 and return public URLs.
 *
 * Usage:
 *   node scripts/upload-pr-images.mjs [--dry-run] [--help] <file1> [file2 ...]
 *
 * Output:
 *   JSON object mapping filenames to public URLs:
 *   { "file1.png": "https://bucket.r2.dev/pr-images/20260324-abc123/file1.png" }
 *
 * Config resolution:
 *   1. ~/.invoker/config.json → imageStorage field
 *   2. Environment variables: R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID,
 *      R2_SECRET_ACCESS_KEY, R2_PUBLIC_URL_BASE
 */

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import aws4 from 'aws4';

const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.svg': 'image/svg+xml',
};

function usage() {
  console.error(`Usage: node scripts/upload-pr-images.mjs [--dry-run] [--help] <file1> [file2 ...]

Uploads files to Cloudflare R2 and prints a JSON map of filename → public URL.

Options:
  --dry-run   Skip actual upload, print placeholder URLs
  --help      Show this help

Config: ~/.invoker/config.json "imageStorage" field, or R2_* env vars.`);
  process.exit(0);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { dryRun: false, files: [] };

  for (const arg of args) {
    if (arg === '--help') usage();
    else if (arg === '--dry-run') parsed.dryRun = true;
    else parsed.files.push(arg);
  }

  return parsed;
}

function loadR2Config() {
  // Try ~/.invoker/config.json first
  try {
    const raw = readFileSync(join(homedir(), '.invoker', 'config.json'), 'utf-8');
    const config = JSON.parse(raw);
    if (config.imageStorage && config.imageStorage.provider === 'r2') {
      const s = config.imageStorage;
      return {
        accountId: s.accountId,
        bucketName: s.bucketName,
        accessKeyId: s.accessKeyId,
        secretAccessKey: s.secretAccessKey,
        publicUrlBase: s.publicUrlBase,
      };
    }
  } catch {
    // Fall through to env vars
  }

  // Fallback to env vars
  const { R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PUBLIC_URL_BASE } = process.env;
  if (R2_ACCOUNT_ID && R2_BUCKET_NAME && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_PUBLIC_URL_BASE) {
    return {
      accountId: R2_ACCOUNT_ID,
      bucketName: R2_BUCKET_NAME,
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
      publicUrlBase: R2_PUBLIC_URL_BASE,
    };
  }

  return null;
}

function getMimeType(filePath) {
  const ext = filePath.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function generatePrefix() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = randomBytes(3).toString('hex');
  return `pr-images/${date}-${rand}`;
}

async function uploadFile(filePath, key, config) {
  const body = readFileSync(filePath);
  const contentType = getMimeType(filePath);
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const path = `/${config.bucketName}/${key}`;

  const opts = aws4.sign({
    host,
    path,
    method: 'PUT',
    body,
    headers: {
      'Content-Type': contentType,
      'Content-Length': body.length,
    },
    service: 's3',
    region: 'auto',
  }, {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  });

  const url = `https://${host}${path}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: opts.headers,
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`R2 PUT ${response.status}: ${text}`);
  }
}

async function main() {
  const { dryRun, files } = parseArgs();

  if (files.length === 0) {
    console.error('Error: no files specified. Run with --help for usage.');
    process.exit(1);
  }

  const config = loadR2Config();
  if (!config && !dryRun) {
    console.error('Error: R2 config not found.');
    console.error('Set imageStorage in ~/.invoker/config.json or export R2_* env vars.');
    console.error('Run with --help for details.');
    process.exit(1);
  }

  const prefix = generatePrefix();
  const results = {};

  for (const filePath of files) {
    const name = basename(filePath);
    const key = `${prefix}/${name}`;

    if (dryRun) {
      results[name] = `https://DRY-RUN/${key}`;
      continue;
    }

    try {
      await uploadFile(filePath, key, config);
      const publicUrl = config.publicUrlBase.replace(/\/+$/, '');
      results[name] = `${publicUrl}/${key}`;
    } catch (err) {
      console.error(`Failed to upload ${name}: ${err.message}`);
    }
  }

  console.log(JSON.stringify(results));
}

main().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
