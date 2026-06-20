#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const IGNORED_DIRS = new Set([
  '.git',
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
const TEMPORARY_LEGACY_JS_IMPORT_EXCEPTIONS = new Set([
  'data-store',
  'execution-engine',
  'graph',
  'runtime-adapters',
  'runtime-domain',
  'runtime-service',
  'svc-api',
  'test-kit',
  'transport',
  'workflow-core',
  'workflow-graph',
]);
const RELATIVE_JS_IMPORT = /(?:from\s+['\"](\.{1,2}\/[^'\"]*\.js)['\"]|import\s+['\"](\.{1,2}\/[^'\"]*\.js)['\"])/g;

function usage() {
  console.error('Usage: node scripts/check-ts-source-imports.mjs [--root <path>]');
}

function parseArgs(argv) {
  let root = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      root = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--root=')) {
      root = arg.slice('--root='.length);
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    console.error(`[ts-source-imports] Unknown argument: ${arg}`);
    usage();
    process.exit(2);
  }
  return path.resolve(root);
}

function pathExists(targetPath) {
  try {
    statSync(targetPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function isTestSource(filePath) {
  const basename = path.basename(filePath);
  return basename.includes('.test.') || basename.includes('.spec.') || basename.includes('.stories.');
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

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function findTsExportedPackages(root) {
  const packagesRoot = path.join(root, 'packages');
  if (!pathExists(packagesRoot)) {
    return [];
  }

  const packages = [];
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageRoot = path.join(packagesRoot, entry.name);
    const packageJsonPath = path.join(packageRoot, 'package.json');
    if (!pathExists(packageJsonPath)) {
      continue;
    }
    const packageJson = readJson(packageJsonPath);
    if (typeof packageJson.main !== 'string' || !packageJson.main.startsWith('src/')) {
      continue;
    }
    packages.push({
      name: entry.name,
      root: packageRoot,
      exempt: TEMPORARY_LEGACY_JS_IMPORT_EXCEPTIONS.has(entry.name),
    });
  }
  return packages;
}

function collectViolations(root, packageInfo) {
  const srcRoot = path.join(packageInfo.root, 'src');
  if (!pathExists(srcRoot) || packageInfo.exempt) {
    return [];
  }

  const violations = [];
  walk(srcRoot, (filePath) => {
    if (!SOURCE_EXTENSIONS.has(path.extname(filePath)) || isTestSource(filePath)) {
      return;
    }
    const content = readFileSync(filePath, 'utf8');
    const imports = [...content.matchAll(RELATIVE_JS_IMPORT)].map((match) => match[1] ?? match[2]).filter(Boolean);
    if (imports.length === 0) {
      return;
    }
    violations.push({
      path: path.relative(root, filePath),
      imports,
    });
  });
  return violations;
}

const root = parseArgs(process.argv.slice(2));
const packages = findTsExportedPackages(root);
const violations = [];
for (const packageInfo of packages) {
  violations.push(...collectViolations(root, packageInfo));
}

violations.sort((a, b) => a.path.localeCompare(b.path));

if (violations.length > 0) {
  console.error('[ts-source-imports] TS-exported packages must not use relative .js imports in non-test source.');
  console.error('[ts-source-imports] Migrate source imports to TS-safe paths or move the package to built-JS exports.');
  for (const violation of violations) {
    console.error(`[ts-source-imports] ${violation.path}: ${violation.imports.join(', ')}`);
  }
  process.exit(1);
}

console.log(`[ts-source-imports] Checked ${packages.length} TS-exported package(s); no forbidden relative .js imports in enforced non-test source.`);
