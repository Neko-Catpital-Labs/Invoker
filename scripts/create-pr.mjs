#!/usr/bin/env node

/**
 * Create or update a GitHub PR with automatic image injection.
 *
 * Usage:
 *   node scripts/create-pr.mjs --title "..." --base <branch> [options]
 *
 * Options:
 *   --title <t>          PR title (required)
 *   --base <b>           Base branch (required)
 *   --body-file <f>      Read PR body from file
 *   --body <text>        Inline PR body
 *   --update <num>       Update existing PR instead of creating new
 *   --update-existing    Update the PR already attached to the current branch
 *   --dry-run            Print what would happen, skip push and API calls
 *   --help               Show this help
 *
 * Stack flow:
 *   1. Publish stack branches with `mergify stack push`
 *   2. Switch to the created stack branch if needed
 *   3. Run `node scripts/create-pr.mjs --title "..." --base <branch> --body-file <file> --update-existing`
 *
 * Image injection:
 *   Scans the body for markdown image/link patterns where the URL is a local
 *   file path. Uploads those files to Cloudflare R2 and replaces the paths
 *   with public URLs.
 *
 * PR body validation:
 *   Enforces the canonical PR schema:
 *   ## Summary with collapsed Review metadata, ## Non-goals,
 *   ## Test Plan, ## Revert Plan, plus optional ## Architecture
 *   and required ## Visual Proof for UI changes.
 */

import { readFileSync, existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import aws4 from 'aws4';
import { getPrBodyWarnings, validatePrBody } from './validate-pr-body.mjs';

const DEFAULT_BASE_REMOTE = process.env.INVOKER_PARENT_REMOTE || 'origin';
const HAS_EXPLICIT_NON_ORIGIN_BASE_REMOTE = Boolean(
  process.env.INVOKER_PARENT_REMOTE && process.env.INVOKER_PARENT_REMOTE !== 'origin',
);

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
    host,
    path,
    method: 'PUT',
    body,
    headers: { 'Content-Type': contentType, 'Content-Length': body.length },
    service: 's3',
    region: 'auto',
  }, { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey });

  const response = await fetch(`https://${host}${path}`, {
    method: 'PUT',
    headers: opts.headers,
    body,
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
  --title <t>          PR title (required)
  --base <b>           Base branch (required)
  --body-file <f>      Read PR body from file
  --body <text>        Inline PR body
  --update <num>       Update existing PR number instead of creating new
  --update-existing    Update the PR already attached to the current branch
  --dry-run            Print actions without executing
  --help               Show this help

Stack PR title schema:
  Stacked PRs must start with a shared idea and one slice index.
  Replacement slices may add one trailing lowercase letter:
  [Graph Blanking](1) Preserve selected graph while loading
  [Graph Blanking](3a) Split follow-up slice

Stack flow:
  1. Publish stack branches with \`mergify stack push\`
  2. Switch to the created stack branch if needed
  3. Run \`node scripts/create-pr.mjs --title "[Graph Blanking](3a) <slice title>" --base <branch> --body-file <file> --update-existing\`

PR body schema:
  Required: ## Summary with collapsed Review metadata, ## Non-goals, ## Test Plan, ## Revert Plan
  Optional: ## Architecture (must include ### Before and ### After when present)
  UI-impacting diffs require ## Visual Proof with screenshot or video proof.
  Template: scripts/pr-body-template.md`);
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    title: '',
    base: '',
    body: '',
    bodyFile: '',
    update: '',
    updateExisting: false,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--help': usage(); break;
      case '--dry-run': parsed.dryRun = true; break;
      case '--title': parsed.title = args[++i] || ''; break;
      case '--base': parsed.base = args[++i] || ''; break;
      case '--body': parsed.body = args[++i] || ''; break;
      case '--body-file': parsed.bodyFile = args[++i] || ''; break;
      case '--update': parsed.update = args[++i] || ''; break;
      case '--update-existing': parsed.updateExisting = true; break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        usage();
    }
  }

  if (parsed.update && parsed.updateExisting) {
    throw new Error('Use either --update <num> or --update-existing, not both.');
  }

  if (!parsed.title || !parsed.base) {
    console.error('Error: --title and --base are required');
    usage();
  }

  return parsed;
}

const TRUNK_BRANCHES = new Set(['main', 'master', 'develop']);
const STACK_PR_TITLE_PATTERN = /^\[[^\[\]\r\n]{3,80}\]\([1-9]\d*[a-z]?\)(?:\s+\S.*)?$/;

function isStackedPrContext(baseBranch, mergifyState) {
  return mergifyState.managed || !TRUNK_BRANCHES.has(baseBranch);
}

function assertValidStackPrTitle(title) {
  if (STACK_PR_TITLE_PATTERN.test(title.trim())) return;

  throw new Error(
    [
      'Stack PR titles must start with a shared idea and exactly one slice index.',
      'Use: [Graph Blanking](1) Preserve selected graph while loading',
      'Use lettered replacements when one published slice must split: [Graph Blanking](3a) Split follow-up slice',
    ].join('\n'),
  );
}

async function assertValidPrBody(body, options = {}) {
  const errors = await validatePrBody(body, options);
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

function printPrBodyWarnings(body, changedFiles = []) {
  const warnings = getPrBodyWarnings(body, { changedFiles });
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
  const pattern = /(!?\[[^\]]*\])\(([^)]+)\)/g;
  const localFiles = [];

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

  return body.replace(pattern, (full, bracket, url) => {
    const replacement = urlMap.get(url);
    return replacement ? `${bracket}(${replacement})` : full;
  });
}

// ── Git + GitHub helpers ────────────────────────────────────────────────────

function runGit(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf-8',
    ...options,
  });
}

function runGh(args, options = {}) {
  return execFileSync('gh', args, {
    encoding: 'utf-8',
    ...options,
  });
}

function gitText(args, options = {}) {
  return runGit(args, options).trim();
}

function gitTextOrEmpty(args, options = {}) {
  try {
    return gitText(args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      ...options,
    });
  } catch {
    return '';
  }
}

function getRepoNwo() {
  try {
    const url = gitText(['remote', 'get-url', DEFAULT_BASE_REMOTE]);
    const match = url.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    if (match) return match[1];
  } catch {
    // No usable base remote; fall back to gh default
  }
  return runGh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
}

function gitPush(dryRun) {
  if (dryRun) {
    console.error('[dry-run] Would run: git push -u origin HEAD');
    return;
  }
  console.error('Pushing branch...');
  execFileSync('git', ['push', '-u', 'origin', 'HEAD'], { stdio: 'inherit' });
}

function getCurrentBranch() {
  return gitText(['branch', '--show-current']);
}

function hasRemote(name) {
  try {
    runGit(['remote', 'get-url', name], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function revList(range) {
  const out = gitTextOrEmpty(['rev-list', range]);
  return out ? out.split('\n').filter(Boolean) : [];
}

function shortOneLine(sha) {
  return gitTextOrEmpty(['show', '--no-patch', '--oneline', '--no-abbrev-commit', sha]) || sha;
}

function resolveRev(ref) {
  return gitText(['rev-parse', ref]);
}

function fetchBranch(remote, branch) {
  runGit(['fetch', '--quiet', remote, branch], { stdio: 'ignore' });
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

function changedFilesSinceBase(baseBranch) {
  try {
    const output = runGit(['diff', '--name-only', `${DEFAULT_BASE_REMOTE}/${baseBranch}...HEAD`]).trim();
    return output ? output.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

function assertCleanPrBase(baseBranch) {
  if (!hasRemote(DEFAULT_BASE_REMOTE)) {
    throw new Error(
      [
        `Missing git base remote "${DEFAULT_BASE_REMOTE}".`,
        `Expected ${DEFAULT_BASE_REMOTE} to point to the base repository.`,
        `Run: git remote add ${DEFAULT_BASE_REMOTE} <base-repo-url>`,
      ].join('\n'),
    );
  }

  if (!hasRemote('origin')) {
    throw new Error(
      [
        'Missing git base remote "origin".',
        'Expected origin to point to the GitHub repository used for PR publication.',
        'Run: git remote add origin <github-repo-url>',
      ].join('\n'),
    );
  }

  fetchBranch('origin', baseBranch);
  const originRef = `origin/${baseBranch}`;
  const originTip = resolveRev(originRef);
  const mergeBase = gitText(['merge-base', 'HEAD', originRef]);
  if (mergeBase !== originTip) {
    const currentBranch = getCurrentBranch();
    throw new Error(
      [
        `Refusing to create/update PR: current branch is not based on the latest ${originRef}.`,
        `Rebuild it from ${originRef} and cherry-pick only the intended commits.`,
        '',
        'Recovery:',
        `  git switch -c pr/<name> ${originRef}`,
        '  git cherry-pick <commit> [<commit> ...]',
        '  git push -u origin pr/<name>',
        '',
        `Current branch: ${currentBranch}`,
      ].join('\n'),
    );
  }

  if (!HAS_EXPLICIT_NON_ORIGIN_BASE_REMOTE || DEFAULT_BASE_REMOTE === 'origin') {
    return;
  }

  fetchBranch(DEFAULT_BASE_REMOTE, baseBranch);
  const originOnly = new Set(revList(`${DEFAULT_BASE_REMOTE}/${baseBranch}..origin/${baseBranch}`));
  if (originOnly.size === 0) return;

  const headOnly = revList(`${DEFAULT_BASE_REMOTE}/${baseBranch}..HEAD`);
  const polluted = headOnly.filter((sha) => originOnly.has(sha));
  if (polluted.length === 0) return;

  const lines = polluted.slice(0, 12).map((sha) => `  - ${shortOneLine(sha)}`);
  const more = polluted.length > 12 ? `\n  ... and ${polluted.length - 12} more` : '';
  const currentBranch = getCurrentBranch();
  throw new Error(
    [
      `Refusing to create/update PR: current branch contains commits unique to origin/${baseBranch}.`,
      'This would pollute the PR with origin-only history.',
      '',
      'Detected commits:',
      ...lines,
      more,
      '',
      `Fix by creating a clean PR branch from ${DEFAULT_BASE_REMOTE}/${baseBranch}, then cherry-picking intended commits:`,
      `  git switch -c pr/<name> ${DEFAULT_BASE_REMOTE}/${baseBranch}`,
      '  git cherry-pick <commit> [<commit> ...]',
      '  git push -u origin pr/<name>',
      '',
      `Current branch: ${currentBranch}`,
    ].join('\n'),
  );
}

function getBranchMergeRef(branch) {
  return gitTextOrEmpty(['config', '--get', `branch.${branch}.merge`]);
}

function getBranchRemote(branch) {
  return gitTextOrEmpty(['config', '--get', `branch.${branch}.remote`]);
}

function resolveTrackedBaseRef(branch) {
  const mergeRef = getBranchMergeRef(branch);
  if (!mergeRef) return '';
  const baseBranch = mergeRef.replace(/^refs\/heads\//, '');
  const remote = getBranchRemote(branch);
  if (remote) {
    const remoteRef = `${remote}/${baseBranch}`;
    if (gitTextOrEmpty(['rev-parse', '--verify', remoteRef])) {
      return remoteRef;
    }
  }
  if (gitTextOrEmpty(['rev-parse', '--verify', baseBranch])) {
    return baseBranch;
  }
  return baseBranch;
}

function branchHasChangeId(baseRef) {
  if (!baseRef) return false;
  try {
    const log = runGit(['log', '--format=%B', `${baseRef}..HEAD`]);
    return /^Change-Id:/m.test(log);
  } catch {
    return false;
  }
}


function getMergifyBranchState(branch = getCurrentBranch()) {
  if (!branch || ['main', 'master', 'develop'].includes(branch)) {
    return { managed: false, branch, trackedBaseRef: '' };
  }

  const trackedBaseRef = resolveTrackedBaseRef(branch);
  if (branch.startsWith('stack/')) {
    return { managed: true, branch, trackedBaseRef };
  }

  const mergeRef = getBranchMergeRef(branch);
  if (!mergeRef) {
    return { managed: false, branch, trackedBaseRef: '' };
  }

  if (!branchHasChangeId(trackedBaseRef)) {
    return { managed: false, branch, trackedBaseRef };
  }

  return { managed: true, branch, trackedBaseRef };
}

function getCurrentUpstream() {
  return gitTextOrEmpty(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
}

function assertPublishedMergifyBranch(branch, trackedBaseRef) {
  let publishedRef = getCurrentUpstream();
  const originBranchRef = `origin/${branch}`;
  if ((!publishedRef || publishedRef === trackedBaseRef) && gitTextOrEmpty(['rev-parse', '--verify', originBranchRef])) {
    publishedRef = originBranchRef;
  }

  if (!publishedRef) {
    throw new Error(
      [
        `Current branch "${branch}" has no published remote branch.`,
        'Run `mergify stack push` first, then rerun this command to update the PR title/body.',
      ].join('\n'),
    );
  }

  const unpublished = revList(`${publishedRef}..HEAD`);
  if (unpublished.length === 0) return;

  throw new Error(
    [
      `Current branch "${branch}" has unpublished local commits ahead of ${publishedRef}.`,
      'Run `mergify stack push` first, then rerun this command to update the PR title/body.',
    ].join('\n'),
  );
}

function listPullRequestsForHead(nwo, branch) {
  const [owner] = nwo.split('/');
  const query = new URLSearchParams({
    state: 'all',
    head: `${owner}:${branch}`,
  }).toString();
  const raw = runGh(['api', `repos/${nwo}/pulls?${query}`]);
  const prs = JSON.parse(raw);
  return prs.filter((pr) => pr?.head?.ref === branch && pr?.head?.repo?.full_name === nwo);
}

function resolveExistingPrNumber(nwo, branch, dryRun) {
  if (dryRun) {
    console.error(`[dry-run] Would resolve PR for current branch: ${branch}`);
    return '0';
  }

  const prs = listPullRequestsForHead(nwo, branch);
  if (prs.length === 1) {
    return String(prs[0].number);
  }

  if (prs.length === 0) {
    throw new Error(
      [
        `No PR exists for current branch "${branch}" in ${nwo}.`,
        'Run `mergify stack push` first for stack branches, or create the PR normally for non-stack branches.',
      ].join('\n'),
    );
  }

  const choices = prs.map((pr) => `  - #${pr.number}: ${pr.html_url}`).join('\n');
  throw new Error(
    [
      `Found multiple PRs for current branch "${branch}" in ${nwo}.`,
      'Refusing to guess. Resolve the duplicate PRs first.',
      choices,
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
  const result = runGh(['api', `repos/${nwo}/pulls`, '--method', 'POST', '--input', '-'], {
    input: payload,
  });
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
  const result = runGh(['api', `repos/${nwo}/pulls/${prNum}`, '--method', 'PATCH', '--input', '-'], {
    input: payload,
  });
  const pr = JSON.parse(result);
  return pr.html_url;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  assertCleanPrBase(args.base);

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

  await assertValidPrBody(body, { requiresVisualProof: uiImpactingFiles.length > 0, changedFiles });
  printPrBodyWarnings(body, changedFiles);
  body = await injectImages(body, args.dryRun);

  const currentBranch = getCurrentBranch();
  const mergifyState = getMergifyBranchState(currentBranch);
  const requestedUpdatePath = Boolean(args.update || args.updateExisting);
  if (mergifyState.managed && !requestedUpdatePath) {
    throw new Error(
      [
        'This branch is managed by Mergify stacks.',
        'Use `mergify stack push` instead of `git push`.',
        '',
        'After the stack branch is published, rerun `create-pr` in update mode on that branch to repair the PR title/body.',
      ].join('\n'),
    );
  }

  if (mergifyState.managed && requestedUpdatePath) {
    assertPublishedMergifyBranch(currentBranch, mergifyState.trackedBaseRef);
  }

  if (isStackedPrContext(args.base, mergifyState)) {
    assertValidStackPrTitle(args.title);
  }

  const nwo = args.dryRun ? 'OWNER/REPO' : getRepoNwo();
  let updatePrNumber = args.update;
  if (args.updateExisting) {
    updatePrNumber = resolveExistingPrNumber(nwo, currentBranch, args.dryRun);
  }

  if (!(mergifyState.managed && requestedUpdatePath)) {
    gitPush(args.dryRun);
  }

  const prUrl = updatePrNumber
    ? await updatePr(nwo, updatePrNumber, args.title, body, args.dryRun)
    : await createPr(nwo, args.title, args.base, body, args.dryRun);

  console.log(prUrl);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  });
}
