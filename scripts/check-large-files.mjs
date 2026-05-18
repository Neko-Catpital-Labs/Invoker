#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const DEFAULT_MAX_LINES = 5200;
const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.mjs', '.ts', '.tsx']);
const IGNORED_DIRS = new Set([
  '.git',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'generated',
  'node_modules',
  'out',
  'playwright-report',
  'release',
  'test-results',
  '__generated__',
  '__mocks__',
  '__tests__',
]);
const IGNORED_FILENAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

function compareStrings(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function usage() {
  console.error('Usage: node scripts/check-large-files.mjs [--root <path>] [--max-lines <count>]');
}

function parseArgs(argv) {
  const options = {
    maxLines: Number(process.env.INVOKER_LARGE_FILE_MAX_LINES || DEFAULT_MAX_LINES),
    root: process.cwd(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      if (!argv[index + 1]) {
        usage();
        process.exit(2);
      }
      options.root = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--max-lines') {
      if (!argv[index + 1]) {
        usage();
        process.exit(2);
      }
      options.maxLines = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    usage();
    process.exit(2);
  }

  if (!Number.isInteger(options.maxLines) || options.maxLines < 1) {
    console.error('ERROR: --max-lines must be a positive integer.');
    process.exit(2);
  }

  return {
    maxLines: options.maxLines,
    root: resolve(options.root),
  };
}

function hasIgnoredSegment(path) {
  return path.split(sep).some((segment) => IGNORED_DIRS.has(segment));
}

function extensionOf(filePath) {
  if (filePath.endsWith('.d.ts')) {
    return '.d.ts';
  }
  const match = filePath.match(/\.[^.]+$/u);
  return match?.[0] ?? '';
}

function isProductionSource(root, filePath) {
  const relPath = relative(root, filePath);
  if (relPath.startsWith('..') || relPath === '') {
    return false;
  }
  if (hasIgnoredSegment(relPath)) {
    return false;
  }
  if (IGNORED_FILENAMES.has(relPath.split(sep).at(-1))) {
    return false;
  }

  const ext = extensionOf(relPath);
  if (!SOURCE_EXTENSIONS.has(ext)) {
    return false;
  }
  if (relPath.endsWith('.test.ts') || relPath.endsWith('.test.tsx') || relPath.endsWith('.spec.ts') || relPath.endsWith('.spec.tsx')) {
    return false;
  }

  const parts = relPath.split(sep);
  return parts.length >= 4 && parts[0] === 'packages' && parts[2] === 'src';
}

function walk(dir, files) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareStrings(a.name, b.name));
  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        walk(path, files);
      }
      continue;
    }
    if (entry.isFile()) {
      files.push(path);
    }
  }
}

function countLines(filePath) {
  const buffer = readFileSync(filePath, 'utf8');
  if (buffer.length === 0) {
    return 0;
  }
  const newlineCount = buffer.match(/\n/gu)?.length ?? 0;
  return buffer.endsWith('\n') ? newlineCount : newlineCount + 1;
}

const { maxLines, root } = parseArgs(process.argv.slice(2));
const files = [];
walk(root, files);

const violations = files
  .filter((filePath) => isProductionSource(root, filePath))
  .map((filePath) => ({
    filePath,
    lines: countLines(filePath),
  }))
  .filter(({ lines }) => lines > maxLines)
  .sort((a, b) => compareStrings(relative(root, a.filePath), relative(root, b.filePath)));

if (violations.length > 0) {
  console.error(`ERROR: production source files exceed ${maxLines} lines:`);
  for (const violation of violations) {
    console.error(`  ${relative(root, violation.filePath)}: ${violation.lines} lines`);
  }
  process.exit(1);
}

console.log(`Large-file guardrail passed: production source files are <= ${maxLines} lines.`);
