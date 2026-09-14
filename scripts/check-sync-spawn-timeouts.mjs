#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const CHECKED_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const EXCLUDED_PACKAGES = new Set(['cli']);
const SYNC_SPAWN_RE = /\b(spawnSync|execFileSync|execSync)\s*\(/g;
const GIT_TIMEOUT_MS = 60_000;

function usage() { console.error('Usage: node scripts/check-sync-spawn-timeouts.mjs [--base <ref>] [--root <path>]'); }

function parseArgs(argv) {
  const parsed = { base: process.env.INVOKER_SYNC_SPAWN_BASE || '', root: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base') { parsed.base = argv[index + 1] || ''; index += 1; }
    else if (arg.startsWith('--base=')) parsed.base = arg.slice('--base='.length);
    else if (arg === '--root') { parsed.root = argv[index + 1] || ''; index += 1; }
    else if (arg.startsWith('--root=')) parsed.root = arg.slice('--root='.length);
    else if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    else { console.error(`[sync-spawn-timeouts] Unknown argument: ${arg}`); usage(); process.exit(2); }
  }
  return { base: parsed.base, root: path.resolve(parsed.root) };
}

function runGit(root, args) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function isCheckedPath(filePath) {
  const normalized = filePath.split(path.sep).join('/');
  const parts = normalized.split('/');
  if (parts.length < 4 || parts[0] !== 'packages' || parts[2] !== 'src' || EXCLUDED_PACKAGES.has(parts[1])) return false;
  if (!CHECKED_EXTENSIONS.has(path.extname(normalized))) return false;
  if (normalized.split('/').some((part) => ['__tests__', 'e2e', 'node_modules', 'dist'].includes(part))) return false;
  return !/\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized);
}

export function callText(source, openParenIndex) {
  let depth = 0;
  for (let index = openParenIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openParenIndex, index + 1);
    }
  }
  return source.slice(openParenIndex);
}

function lineStartOffsets(text) {
  const offsets = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') offsets.push(index + 1);
  }
  return offsets;
}

export function collectUnboundedSyncSpawns(diffText, readPostImage, source = 'diff') {
  const violations = [];
  let currentPath = '';
  let checked = false;
  let newLine = 0;
  let fileText;
  let offsets;

  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      currentPath = line.slice(4).trim().replace(/^b[/]/, '');
      checked = currentPath !== '/dev/null' && isCheckedPath(currentPath);
      fileText = undefined;
      offsets = undefined;
      continue;
    }
    if (line.startsWith('@@ ')) {
      const match = /\+(\d+)/.exec(line);
      newLine = match ? Number.parseInt(match[1], 10) : 0;
      continue;
    }
    if (!checked || newLine < 1) continue;
    const isAdded = line.startsWith('+');
    const isContext = line.startsWith(' ');
    if (!isAdded && !isContext) continue;

    if (isAdded) {
      const sourceLine = line.slice(1);
      for (const match of sourceLine.matchAll(SYNC_SPAWN_RE)) {
        if (fileText === undefined) {
          try {
            fileText = readPostImage(currentPath);
            offsets = lineStartOffsets(fileText);
          } catch (error) {
            fileText = null;
            violations.push({
              source, path: currentPath, line: newLine, text: sourceLine.trim(),
              reason: `unchecked: could not read post-image (${error instanceof Error ? error.message : String(error)})`,
            });
          }
        }
        if (fileText === null) continue;
        const openParen = offsets[newLine - 1] + match.index + match[0].length - 1;
        if (!/\btimeout\b/.test(callText(fileText, openParen))) {
          violations.push({ source, path: currentPath, line: newLine, text: sourceLine.trim(), reason: 'no timeout option' });
        }
      }
    }
    newLine += 1;
  }
  return violations;
}

function defaultBase(root) {
  for (const candidate of ['origin/master', 'origin/main']) {
    const result = spawnSync('git', ['merge-base', candidate, 'HEAD'], { cwd: root, stdio: 'ignore', timeout: GIT_TIMEOUT_MS });
    if (result.status === 0) return candidate;
  }
  return '';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = args.base || defaultBase(args.root);
  const sources = [];
  if (base) {
    sources.push({
      name: `${base}...HEAD`,
      text: runGit(args.root, ['diff', '--unified=0', '--diff-filter=ACMRT', `${base}...HEAD`, '--']),
      read: (filePath) => runGit(args.root, ['show', `HEAD:${filePath}`]),
    });
  }
  sources.push({
    name: 'staged changes',
    text: runGit(args.root, ['diff', '--cached', '--unified=0', '--diff-filter=ACMRT', '--']),
    read: (filePath) => runGit(args.root, ['show', `:${filePath}`]),
  });
  sources.push({
    name: 'working tree changes',
    text: runGit(args.root, ['diff', '--unified=0', '--diff-filter=ACMRT', '--']),
    read: (filePath) => readFileSync(path.join(args.root, filePath), 'utf8'),
  });
  const violations = sources.flatMap((source) => collectUnboundedSyncSpawns(source.text, source.read, source.name));
  if (violations.length > 0) {
    console.error(`[sync-spawn-timeouts] Found ${violations.length} newly-added synchronous child process call(s) without a timeout.`);
    console.error('[sync-spawn-timeouts] A blocking spawn with no timeout can freeze the whole Invoker process. Pass a timeout option, or use an async spawn.');
    for (const violation of violations) {
      console.error(`[sync-spawn-timeouts] ${violation.path}:${violation.line} (${violation.source}, ${violation.reason}) ${violation.text}`);
    }
    process.exit(1);
  }
  console.log('[sync-spawn-timeouts] Checked added source lines; every synchronous child process call has a timeout.');
}

if (path.resolve(process.argv[1] || '') === path.resolve(new URL(import.meta.url).pathname)) main();
