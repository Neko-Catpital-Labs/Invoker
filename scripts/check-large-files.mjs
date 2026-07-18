#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_MAX_LINES = 5500;
const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const IGNORED_DIRS = new Set([
  '.git',
  '.next',
  'build',
  'coverage',
  'dist',
  'e2e',
  'fixtures',
  'node_modules',
  'out',
  '__generated__',
  '__tests__',
]);
const IGNORED_FILES = new Set([
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

function usage() {
  console.error('Usage: node scripts/check-large-files.mjs [--root <path>] [--max-lines <count>]');
}

function parseArgs(argv) {
  let root = process.cwd();
  let maxLines = Number.parseInt(process.env.INVOKER_MAX_SOURCE_LINES || '', 10);
  if (!Number.isFinite(maxLines)) {
    maxLines = DEFAULT_MAX_LINES;
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      root = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--root=')) {
      root = arg.slice('--root='.length);
    } else if (arg === '--max-lines') {
      maxLines = Number.parseInt(argv[index + 1] || '', 10);
      index += 1;
    } else if (arg.startsWith('--max-lines=')) {
      maxLines = Number.parseInt(arg.slice('--max-lines='.length), 10);
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      console.error(`[large-files] Unknown argument: ${arg}`);
      usage();
      process.exit(2);
    }
  }

  if (!root || !Number.isInteger(maxLines) || maxLines < 1) {
    usage();
    process.exit(2);
  }

  return {
    root: path.resolve(root),
    maxLines,
  };
}

function pathExists(filePath) {
  try {
    statSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function isGeneratedOrBuildArtifact(filePath) {
  const basename = path.basename(filePath);
  return (
    IGNORED_FILES.has(basename) ||
    basename.endsWith('.d.ts') ||
    basename.includes('.gen.') ||
    basename.includes('.generated.')
  );
}

function isProductionSource(filePath) {
  const basename = path.basename(filePath);
  const ext = path.extname(basename);
  return (
    SOURCE_EXTENSIONS.has(ext) &&
    !isGeneratedOrBuildArtifact(filePath) &&
    !basename.includes('.test.') &&
    !basename.includes('.spec.') &&
    !basename.includes('.stories.')
  );
}

function countLines(filePath) {
  const content = readFileSync(filePath);
  if (content.length === 0) {
    return 0;
  }

  let lines = 0;
  for (const byte of content) {
    if (byte === 10) {
      lines += 1;
    }
  }

  return content[content.length - 1] === 10 ? lines : lines + 1;
}

function walk(dir, visit) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        walk(entryPath, visit);
      }
      continue;
    }

    if (entry.isFile()) {
      visit(entryPath);
    }
  }
}

function sourceRoots(root) {
  const roots = [];
  const topLevelSrc = path.join(root, 'src');
  if (pathExists(topLevelSrc)) {
    roots.push(topLevelSrc);
  }

  const packagesRoot = path.join(root, 'packages');
  if (pathExists(packagesRoot)) {
    const packageDirs = readdirSync(packagesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !IGNORED_DIRS.has(entry.name))
      .map((entry) => path.join(packagesRoot, entry.name, 'src'))
      .filter(pathExists);
    roots.push(...packageDirs);
  }

  return roots.sort((a, b) => a.localeCompare(b));
}

const { root, maxLines } = parseArgs(process.argv.slice(2));
const violations = [];

for (const sourceRoot of sourceRoots(root)) {
  walk(sourceRoot, (filePath) => {
    if (!isProductionSource(filePath)) {
      return;
    }

    const lines = countLines(filePath);
    if (lines > maxLines) {
      violations.push({
        path: path.relative(root, filePath),
        lines,
      });
    }
  });
}

violations.sort((a, b) => a.path.localeCompare(b.path));

if (violations.length > 0) {
  console.error(`[large-files] ${violations.length} production source file(s) exceed ${maxLines} lines:`);
  for (const violation of violations) {
    console.error(`[large-files] ${violation.path}: ${violation.lines} lines`);
  }
  process.exit(1);
}

console.log(`[large-files] Checked production source files; all are <= ${maxLines} lines.`);
