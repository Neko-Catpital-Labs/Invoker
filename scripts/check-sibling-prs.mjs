#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const GH_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const GH_TIMEOUT_MS = 10_000;

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = { base: 'origin/master' };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--base':
        parsed.base = argv[++i] || '';
        break;
      case '--help':
        console.log('Usage: node scripts/check-sibling-prs.mjs --base <ref>');
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option: ${argv[i]}`);
    }
  }

  if (!parsed.base) throw new Error('--base requires a ref');
  return parsed;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf-8',
    ...options,
  });
}

function currentBranch() {
  return run('git', ['branch', '--show-current'], {
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  }).trim();
}

function changedFiles(base) {
  const output = run('git', ['diff', '--name-only', `${base}...HEAD`], {
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  }).trim();
  return output ? output.split('\n').filter(Boolean) : [];
}

function openPullRequests() {
  const output = run('gh', ['pr', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,title,headRefName,files'], {
    maxBuffer: GH_MAX_BUFFER_BYTES,
    timeout: GH_TIMEOUT_MS,
  }).trim();
  return output ? JSON.parse(output) : [];
}

function filePath(file) {
  if (typeof file === 'string') return file;
  if (file && typeof file.path === 'string') return file.path;
  return '';
}

function reasonFromError(error) {
  const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : '';
  if (stderr) return stderr.split('\n')[0];
  if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') return 'gh timed out';
  return error.message || String(error);
}

export function formatSiblingOverlaps({ pullRequests, changedPaths, branch }) {
  const changed = new Set(changedPaths);
  const lines = [];

  for (const pr of pullRequests) {
    if (!pr || pr.headRefName === branch) continue;
    const overlaps = (Array.isArray(pr.files) ? pr.files : [])
      .map(filePath)
      .filter((path) => path && changed.has(path))
      .sort();
    if (overlaps.length === 0) continue;
    lines.push(`#${pr.number} ${pr.title} -- overlaps: ${overlaps.join(', ')}`);
  }

  return lines;
}

function main() {
  try {
    const { base } = parseArgs();
    const branch = currentBranch();
    const changedPaths = changedFiles(base);
    if (changedPaths.length === 0) return;

    const pullRequests = openPullRequests();
    const lines = formatSiblingOverlaps({ pullRequests, changedPaths, branch });
    if (lines.length > 0) {
      console.log(lines.join('\n'));
    }
  } catch (error) {
    console.log(`sibling-pr check could not run: ${reasonFromError(error)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
