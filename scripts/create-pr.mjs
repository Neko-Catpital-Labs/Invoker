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
 *
 * PR body validation:
 *   Enforces the canonical PR schema:
 *   ## Summary, ## Test Plan, ## Revert Plan, plus optional ## Architecture.
 */

import { readFileSync, existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';
import aws4 from 'aws4';
import { getPrBodyWarnings, validatePrBody } from './validate-pr-body.mjs';

const DEFAULT_PARENT_REMOTE = process.env.INVOKER_PARENT_REMOTE || 'upstream';

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
  --help             Show this help

PR body schema:
  Required: ## Summary, ## Review Claim, ## Review Lane, ## Safety Invariant, ## Slice Rationale, ## Non-goals, ## Test Plan, ## Revert Plan
  Optional: ## Architecture (must include ### Before and ### After when present)
  UI-impacting diffs require ## Visual Proof with screenshot or video proof.
  Template: scripts/pr-body-template.md`);
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

function assertValidPrBody(body, options = {}) {
  const errors = validatePrBody(body, options);
  if (errors.length === 0) return;

  throw new Error(
    [
      'PR body does not match the canonical review-compression schema.',
      ...errors.map((error) => `- ${error}`),
      '',
      options.requiresVisualProof
        ? 'UI-impacting files changed. Add ## Visual Proof with screenshot or video links, or run the visual-proof capture first.'
        : '',
      '',
      'Start from scripts/pr-body-template.md and validate with:',
      '  node scripts/validate-pr-body.mjs --body-file <file>',
    ].join('\n'),
  );
}

function printPrBodyWarnings(body, options = {}) {
  const warnings = getPrBodyWarnings(body, options);
  if (warnings.length === 0) return;

  console.error('PR body validation warnings:');
  for (const warning of warnings) {
    console.error(`- ${warning}`);
  }
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
  // Prefer parent remote (fork workflow: PRs target parent, not the fork)
  try {
    const url = execSync(`git remote get-url ${DEFAULT_PARENT_REMOTE}`, { encoding: 'utf-8' }).trim();
    const match = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    if (match) return match[1];
  } catch {
    // No parent remote; fall back to gh default
  }
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

function hasRemote(name) {
  try {
    execSync(`git remote get-url ${name}`, { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function revList(range) {
  try {
    const out = execSync(`git rev-list ${range}`, { encoding: 'utf-8' }).trim();
    return out ? out.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

function shortOneLine(sha) {
  try {
    return execSync(`git show --no-patch --oneline --no-abbrev-commit ${sha}`, { encoding: 'utf-8' }).trim();
  } catch {
    return sha;
  }
}

export function isUiImpactingPath(filePath) {
  const path = filePath.replace(/\\/g, '/');
  if (path.startsWith('packages/ui/')) return true;
  if (path.startsWith('packages/app/src/window/')) return true;
  if (path === 'packages/app/src/main.ts') return true;
  if (path === 'packages/app/src/preload.ts') return true;
  if (path === 'packages/app/src/app-menu.ts') return true;
  return false;
}

export function getUiImpactingFiles(files) {
  return files.filter(isUiImpactingPath);
}

export function parsePorcelainChangedFiles(statusText) {
  return statusText
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function changedFilesSinceBase(baseBranch) {
  try {
    const output = execFileSync(
      'git',
      ['diff', '--name-only', `${DEFAULT_PARENT_REMOTE}/${baseBranch}...HEAD`],
      { encoding: 'utf-8' },
    ).trim();
    return output ? output.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

function uncommittedFiles() {
  try {
    const output = execFileSync(
      'git',
      ['status', '--porcelain', '--untracked-files=all'],
      { encoding: 'utf-8' },
    );
    return parsePorcelainChangedFiles(output);
  } catch {
    return [];
  }
}

function assertNoUncommittedFiles() {
  const files = uncommittedFiles();
  if (files.length === 0) return;

  throw new Error(
    [
      'Refusing to create/update PR with uncommitted changes.',
      'Commit, split, or stash these files first; uncommitted files are not included in review-lane validation.',
      ...files.map((file) => `  - ${file}`),
    ].join('\n'),
  );
}


function assertCleanPrBase(baseBranch) {
  if (!hasRemote(DEFAULT_PARENT_REMOTE)) {
    throw new Error(
      [
        `Missing git parent remote "${DEFAULT_PARENT_REMOTE}".`,
        `Expected ${DEFAULT_PARENT_REMOTE} to point to the parent repository.`,
        `Run: git remote add ${DEFAULT_PARENT_REMOTE} <parent-repo-url>`,
      ].join('\n'),
    );
  }

  // Keep the check deterministic against latest refs.
  execSync(`git fetch --quiet ${DEFAULT_PARENT_REMOTE} ${baseBranch}`, { stdio: 'ignore' });
  execSync(`git fetch --quiet origin ${baseBranch}`, { stdio: 'ignore' });

  const originOnly = new Set(revList(`${DEFAULT_PARENT_REMOTE}/${baseBranch}..origin/${baseBranch}`));
  if (originOnly.size === 0) return;

  const headOnly = revList(`${DEFAULT_PARENT_REMOTE}/${baseBranch}..HEAD`);
  const polluted = headOnly.filter((sha) => originOnly.has(sha));
  if (polluted.length === 0) return;

  const lines = polluted.slice(0, 12).map((sha) => `  - ${shortOneLine(sha)}`);
  const more = polluted.length > 12 ? `\n  ... and ${polluted.length - 12} more` : '';
  const currentBranch = getCurrentBranch();
  throw new Error(
    [
      `Refusing to create/update PR: current branch contains commits unique to origin/${baseBranch}.`,
      'This would pollute the PR with fork-only history.',
      '',
      'Detected commits:',
      ...lines,
      more,
      '',
      `Fix by creating a clean PR branch from ${DEFAULT_PARENT_REMOTE}/${baseBranch}, then cherry-picking intended commits:`,
      `  git switch -c pr/<name> ${DEFAULT_PARENT_REMOTE}/${baseBranch}`,
      `  git cherry-pick <commit> [<commit> ...]`,
      `  git push -u origin pr/<name>`,
      '',
      `Current branch: ${currentBranch}`,
    ].join('\n'),
  );
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

  assertCleanPrBase(args.base);
  assertNoUncommittedFiles();

  // Read body
  let body = '';
  if (args.bodyFile) {
    body = readFileSync(args.bodyFile, 'utf-8');
  } else if (args.body) {
    body = args.body;
  }

  const changedFiles = changedFilesSinceBase(args.base);
  const uiImpactingFiles = getUiImpactingFiles(changedFiles);
  if (uiImpactingFiles.length > 0) {
    console.error(`UI-impacting files changed; requiring visual proof: ${uiImpactingFiles.join(', ')}`);
  }

  assertValidPrBody(body, { requiresVisualProof: uiImpactingFiles.length > 0, changedFiles });
  printPrBodyWarnings(body, { changedFiles });

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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  });
}
