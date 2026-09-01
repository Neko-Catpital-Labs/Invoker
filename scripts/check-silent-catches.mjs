#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const CHECKED_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const SKIPPED_PATH_PARTS = new Set(['.git', 'node_modules', 'dist', 'coverage', 'out']);
const EMPTY_CATCH_RE = /\bcatch\s*(?:\([^)]*\))?\s*\{([^{}]*)\}/g;

function usage() { console.error('Usage: node scripts/check-silent-catches.mjs [--base <ref>] [--root <path>]'); }

function parseArgs(argv) {
  const parsed = { base: process.env.INVOKER_SILENT_CATCH_BASE || '', root: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base') { parsed.base = argv[index + 1] || ''; index += 1; }
    else if (arg.startsWith('--base=')) parsed.base = arg.slice('--base='.length);
    else if (arg === '--root') { parsed.root = argv[index + 1] || ''; index += 1; }
    else if (arg.startsWith('--root=')) parsed.root = arg.slice('--root='.length);
    else if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    else { console.error(`[silent-catches] Unknown argument: ${arg}`); usage(); process.exit(2); }
  }
  return { base: parsed.base, root: path.resolve(parsed.root) };
}

function runGit(root, args) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function isCheckedFile(filePath) {
  const normalized = filePath.split(path.sep).join('/');
  if (!CHECKED_EXTENSIONS.has(path.extname(normalized))) return false;
  return !normalized.split('/').some((part) => SKIPPED_PATH_PARTS.has(part));
}

function commentFreeBody(body) {
  return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/g, '').trim();
}

export function collectAddedSilentCatchViolations(diffText, source = 'diff') {
  const violations = [];
  let currentPath = '';
  let checked = false;
  let newLine = 0;
  let pendingCatch = null;

  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      currentPath = line.slice(4).trim().replace(/^b\//, '');
      checked = currentPath !== '/dev/null' && isCheckedFile(currentPath);
      pendingCatch = null;
      continue;
    }
    if (line.startsWith('@@ ')) {
      const match = /\+(\d+)/.exec(line);
      newLine = match ? Number.parseInt(match[1], 10) : 0;
      continue;
    }
    if (!checked || newLine < 1) continue;

    const isAdded = line.startsWith('+') && !line.startsWith('+++');
    const isContext = line.startsWith(' ') || line === '';
    if (isAdded || isContext) {
      const sourceLine = line.slice(1);
      if (pendingCatch) {
        const bodyLine = commentFreeBody(sourceLine);
        if (bodyLine !== '') {
          if (bodyLine.startsWith('}')) violations.push(pendingCatch);
          pendingCatch = null;
        }
      }
      if (isAdded) {
        for (const match of sourceLine.matchAll(EMPTY_CATCH_RE)) {
          if (commentFreeBody(match[1]) === '') {
            violations.push({ source, path: currentPath, line: newLine, text: sourceLine.trim() });
          }
        }
        if (/\bcatch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/.*)?$/.test(sourceLine)) {
          pendingCatch = { source, path: currentPath, line: newLine, text: sourceLine.trim() };
        }
      }
      newLine += 1;
    }
  }
  return violations;
}

function defaultBase(root) {
  for (const candidate of ['origin/master', 'origin/main']) {
    try { runGit(root, ['merge-base', candidate, 'HEAD']); return candidate; }
    catch { /* Try the next conventional base ref. */ }
  }
  return '';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = args.base || defaultBase(args.root);
  const sources = [];
  if (base) sources.push({ name: `${base}...HEAD`, text: runGit(args.root, ['diff', '--unified=0', '--diff-filter=ACMRT', `${base}...HEAD`, '--']) });
  sources.push({ name: 'staged changes', text: runGit(args.root, ['diff', '--cached', '--unified=0', '--diff-filter=ACMRT', '--']) });
  sources.push({ name: 'working tree changes', text: runGit(args.root, ['diff', '--unified=0', '--diff-filter=ACMRT', '--']) });
  const violations = sources.flatMap((source) => collectAddedSilentCatchViolations(source.text, source.name));
  if (violations.length > 0) {
    console.error(`[silent-catches] Found ${violations.length} newly-added empty catch block(s).`);
    console.error('[silent-catches] Handle, rethrow, or explicitly report every caught error.');
    for (const violation of violations) console.error(`[silent-catches] ${violation.path}:${violation.line} (${violation.source}) ${violation.text}`);
    process.exit(1);
  }
  console.log('[silent-catches] Checked added source lines; no empty catch blocks found.');
}

if (path.resolve(process.argv[1] || '') === path.resolve(new URL(import.meta.url).pathname)) main();
