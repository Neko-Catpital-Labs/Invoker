#!/usr/bin/env node

/**
 * Create or update a GitHub PR with automatic image injection.
 *
 * Usage:
 *   node scripts/create-pr.mjs --title "..." --base <branch> [options]
 *
 * Options:
 *   --title <t>        PR title (required)
 *   --base <b>         Base branch (required)
 *   --body-file <f>    Read PR body from file
 *   --body <text>      Inline PR body
 *   --update <num>     Update existing PR instead of creating new
 *   --dry-run          Print what would happen, skip push and API calls
 *   --help             Show this help
 *
 * Image injection:
 *   Scans the body for markdown image/link patterns where the URL is a local
 *   file path. Uploads those files to Cloudflare R2 and replaces the paths
 *   with public URLs.
 */

import { readFileSync, existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import aws4 from 'aws4';

// ── R2 upload (duplicated from upload-pr-images.mjs for standalone use) ─────

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

function loadR2Config() {
  try {
    const raw = readFileSync(join(homedir(), '.invoker', 'config.json'), 'utf-8');
    const config = JSON.parse(raw);
    if (config.imageStorage?.provider === 'r2') {
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
  const { R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PUBLIC_URL_BASE } = process.env;
  if (R2_ACCOUNT_ID && R2_BUCKET_NAME && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_PUBLIC_URL_BASE) {
    return { accountId: R2_ACCOUNT_ID, bucketName: R2_BUCKET_NAME, accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, publicUrlBase: R2_PUBLIC_URL_BASE };
  }
  return null;
}

function generatePrefix() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = randomBytes(3).toString('hex');
  return `pr-images/${date}-${rand}`;
}

async function uploadToR2(filePath, key, config) {
  const body = readFileSync(filePath);
  const ext = extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const path = `/${config.bucketName}/${key}`;

  const opts = aws4.sign({
    host, path, method: 'PUT', body,
    headers: { 'Content-Type': contentType, 'Content-Length': body.length },
    service: 's3', region: 'auto',
  }, { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey });

  const response = await fetch(`https://${host}${path}`, {
    method: 'PUT', headers: opts.headers, body,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`R2 PUT ${response.status}: ${text}`);
  }
  const publicBase = config.publicUrlBase.replace(/\/+$/, '');
  return `${publicBase}/${key}`;
}

// ── Argument parsing ────────────────────────────────────────────────────────

function usage() {
  console.error(`Usage: node scripts/create-pr.mjs --title "..." --base <branch> [options]

Options:
  --title <t>        PR title (required)
  --base <b>         Base branch (required)
  --body-file <f>    Read PR body from file
  --body <text>      Inline PR body
  --update <num>     Update existing PR number instead of creating new
  --dry-run          Print actions without executing
  --help             Show this help`);
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { title: '', base: '', body: '', bodyFile: '', update: '', dryRun: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--help': usage(); break;
      case '--dry-run': parsed.dryRun = true; break;
      case '--title': parsed.title = args[++i] || ''; break;
      case '--base': parsed.base = args[++i] || ''; break;
      case '--body': parsed.body = args[++i] || ''; break;
      case '--body-file': parsed.bodyFile = args[++i] || ''; break;
      case '--update': parsed.update = args[++i] || ''; break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        usage();
    }
  }

  if (!parsed.title || !parsed.base) {
    console.error('Error: --title and --base are required');
    usage();
  }

  return parsed;
}

// ── Image injection ─────────────────────────────────────────────────────────

/**
 * Find markdown image/link patterns with local file paths and upload them.
 * Matches: ![alt](path) and [text](path) where path is not http(s).
 */
async function injectImages(body, dryRun) {
  // Match ![...](<path>) or [...](<path>) where path doesn't start with http
  const pattern = /(!?\[[^\]]*\])\(([^)]+)\)/g;
  const localFiles = [];

  // Collect local file paths
  let match;
  while ((match = pattern.exec(body)) !== null) {
    const url = match[2];
    if (/^https?:\/\//.test(url)) continue;
    if (!existsSync(url)) continue;
    localFiles.push(url);
  }

  if (localFiles.length === 0) return body;

  const r2Config = loadR2Config();
  if (!r2Config && !dryRun) {
    console.error('Warning: R2 config not found. Local image paths will not be replaced.');
    console.error('Set imageStorage in ~/.invoker/config.json or export R2_* env vars.');
    return body;
  }

  const prefix = generatePrefix();
  const urlMap = new Map();

  for (const filePath of localFiles) {
    if (urlMap.has(filePath)) continue;
    const name = basename(filePath);
    const key = `${prefix}/${name}`;

    if (dryRun) {
      urlMap.set(filePath, `https://DRY-RUN/${key}`);
      console.error(`[dry-run] Would upload: ${filePath} → ${key}`);
    } else {
      try {
        const publicUrl = await uploadToR2(filePath, key, r2Config);
        urlMap.set(filePath, publicUrl);
        console.error(`Uploaded: ${filePath} → ${publicUrl}`);
      } catch (err) {
        console.error(`Failed to upload ${filePath}: ${err.message}`);
      }
    }
  }

  // Replace local paths with public URLs
  return body.replace(pattern, (full, bracket, url) => {
    const replacement = urlMap.get(url);
    return replacement ? `${bracket}(${replacement})` : full;
  });
}

// ── Git + GitHub helpers ────────────────────────────────────────────────────

function getRepoNwo() {
  return execSync('gh repo view --json nameWithOwner -q .nameWithOwner', { encoding: 'utf-8' }).trim();
}

function gitPush(dryRun) {
  if (dryRun) {
    console.error('[dry-run] Would run: git push -u origin HEAD');
    return;
  }
  console.error('Pushing branch...');
  execSync('git push -u origin HEAD', { stdio: 'inherit' });
}

function getCurrentBranch() {
  return execSync('git branch --show-current', { encoding: 'utf-8' }).trim();
}

async function createPr(nwo, title, base, body, dryRun) {
  const head = getCurrentBranch();

  if (dryRun) {
    console.error(`[dry-run] Would create PR: "${title}" (${head} → ${base})`);
    console.error(`[dry-run] Body length: ${body.length} chars`);
    return 'https://DRY-RUN/pull/0';
  }

  const payload = JSON.stringify({ title, body, head, base });
  const result = execSync(
    `gh api repos/${nwo}/pulls --method POST --input -`,
    { input: payload, encoding: 'utf-8' },
  );
  const pr = JSON.parse(result);
  return pr.html_url;
}

async function updatePr(nwo, prNum, title, body, dryRun) {
  if (dryRun) {
    console.error(`[dry-run] Would update PR #${prNum}: "${title}"`);
    console.error(`[dry-run] Body length: ${body.length} chars`);
    return `https://DRY-RUN/pull/${prNum}`;
  }

  const payload = JSON.stringify({ title, body });
  const result = execSync(
    `gh api repos/${nwo}/pulls/${prNum} --method PATCH --input -`,
    { input: payload, encoding: 'utf-8' },
  );
  const pr = JSON.parse(result);
  return pr.html_url;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  // Read body
  let body = '';
  if (args.bodyFile) {
    body = readFileSync(args.bodyFile, 'utf-8');
  } else if (args.body) {
    body = args.body;
  }

  // Inject images
  body = await injectImages(body, args.dryRun);

  // Push
  gitPush(args.dryRun);

  // Create or update PR
  const nwo = args.dryRun ? 'OWNER/REPO' : getRepoNwo();
  let prUrl;

  if (args.update) {
    prUrl = await updatePr(nwo, args.update, args.title, body, args.dryRun);
  } else {
    prUrl = await createPr(nwo, args.title, args.base, body, args.dryRun);
  }

  // Print PR URL to stdout (only useful output to stdout)
  console.log(prUrl);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
