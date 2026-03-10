#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const MODULE_NAME = 'better-sqlite3';

// pnpm strict linking means better-sqlite3 isn't resolvable from root.
// Resolve from a workspace package that depends on it, or fall back to glob.
function findBinaryPath() {
  const searchRoots = [
    path.join(__dirname, '..', 'packages', 'persistence'),
    path.join(__dirname, '..', 'packages', 'app'),
    path.join(__dirname, '..', 'packages', 'surfaces'),
    __dirname,
  ];
  for (const root of searchRoots) {
    try {
      const pkgPath = require.resolve(`${MODULE_NAME}/package.json`, { paths: [root] });
      const binaryPath = path.join(path.dirname(pkgPath), 'build', 'Release', 'better_sqlite3.node');
      if (fs.existsSync(binaryPath)) return binaryPath;
    } catch {}
  }
  // Last resort: glob the pnpm store
  const storeGlob = path.join(__dirname, '..', 'node_modules', '.pnpm', `${MODULE_NAME}@*`, 'node_modules', MODULE_NAME, 'build', 'Release', 'better_sqlite3.node');
  const { globSync } = require('fs');
  try {
    const matches = fs.readdirSync(path.join(__dirname, '..', 'node_modules', '.pnpm'))
      .filter(d => d.startsWith('better-sqlite3@'))
      .map(d => path.join(__dirname, '..', 'node_modules', '.pnpm', d, 'node_modules', MODULE_NAME, 'build', 'Release', 'better_sqlite3.node'))
      .filter(p => fs.existsSync(p));
    if (matches.length > 0) return matches[0];
  } catch {}
  return null;
}

function getBinaryModuleVersion(binaryPath) {
  try {
    const nm = execSync(`nm -D "${binaryPath}" 2>/dev/null || nm "${binaryPath}"`, { encoding: 'utf8' });
    const match = nm.match(/node_register_module_v(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

function tryLoad() {
  // Clear all cached better-sqlite3 modules so we pick up rebuilt binaries
  for (const key of Object.keys(require.cache)) {
    if (key.includes('better-sqlite3') || key.includes('better_sqlite3')) {
      delete require.cache[key];
    }
  }

  const searchRoots = [
    path.join(__dirname, '..', 'packages', 'persistence'),
    path.join(__dirname, '..', 'packages', 'app'),
    path.join(__dirname, '..', 'packages', 'surfaces'),
    __dirname,
  ];
  let lastError = 'no search roots matched';
  for (const root of searchRoots) {
    try {
      const resolved = require.resolve(MODULE_NAME, { paths: [root] });
      const Database = require(resolved);
      const db = new Database(':memory:');
      db.prepare('SELECT 1').get();
      db.close();
      return { ok: true };
    } catch (e) {
      lastError = e.message;
      continue;
    }
  }
  return { ok: false, error: lastError };
}

function rebuild() {
  const runtimeVer = parseInt(process.versions.modules, 10);

  // Try pnpm rebuild first (handles prebuild-install download)
  console.log(`[check-native-modules] Running: pnpm rebuild ${MODULE_NAME}`);
  try {
    execSync(`pnpm rebuild ${MODULE_NAME}`, { stdio: 'inherit' });
  } catch {}

  // Check if pnpm rebuild fixed it (binary exists with correct MODULE_VERSION)
  const binaryAfter = findBinaryPath();
  const versionAfter = binaryAfter ? getBinaryModuleVersion(binaryAfter) : null;
  const needsNodeGyp = !binaryAfter || (versionAfter && versionAfter !== runtimeVer);

  if (needsNodeGyp) {
    // pnpm rebuild didn't fix it. Common causes:
    // - Binary missing and build/ dir still exists (prebuild-install skips)
    // - Binary compiled for wrong ABI (e.g., Electron vs Node)
    const pkgDir = findPackageDir();
    if (pkgDir) {
      console.log(`[check-native-modules] Running: node-gyp rebuild in ${pkgDir}`);
      try {
        execSync('npx node-gyp rebuild', { cwd: pkgDir, stdio: 'inherit' });
      } catch {
        return false;
      }
    } else {
      return false;
    }
  }
  return true;
}

function findPackageDir() {
  const searchRoots = [
    path.join(__dirname, '..', 'packages', 'persistence'),
    path.join(__dirname, '..', 'packages', 'app'),
    path.join(__dirname, '..', 'packages', 'surfaces'),
  ];
  for (const root of searchRoots) {
    try {
      const pkgPath = require.resolve(`${MODULE_NAME}/package.json`, { paths: [root] });
      return path.dirname(pkgPath);
    } catch {}
  }
  // Fall back to pnpm store scan
  const pnpmDir = path.join(__dirname, '..', 'node_modules', '.pnpm');
  try {
    const dirs = fs.readdirSync(pnpmDir).filter(d => d.startsWith('better-sqlite3@'));
    if (dirs.length > 0) {
      return path.join(pnpmDir, dirs[0], 'node_modules', MODULE_NAME);
    }
  } catch {}
  return null;
}

// --- Main ---

const runtimeVersion = parseInt(process.versions.modules, 10);
const binaryPath = findBinaryPath();

if (!binaryPath) {
  console.log(`[check-native-modules] ${MODULE_NAME} binary not found. Rebuilding...`);
  if (!rebuild()) {
    console.error(`[check-native-modules] FATAL: rebuild failed`);
    process.exit(1);
  }
} else {
  const binaryVersion = getBinaryModuleVersion(binaryPath);
  if (binaryVersion && binaryVersion !== runtimeVersion) {
    console.log(
      `[check-native-modules] MODULE_VERSION mismatch: binary=${binaryVersion}, runtime=${runtimeVersion}. Rebuilding...`
    );
    if (!rebuild()) {
      console.error(`[check-native-modules] FATAL: rebuild failed`);
      process.exit(1);
    }
  }
}

// Final load check
const result = tryLoad();
if (result.ok) {
  console.log(`[check-native-modules] ${MODULE_NAME} OK`);
  process.exit(0);
}

// Load failed — try rebuild as last resort
console.log(`[check-native-modules] ${MODULE_NAME} failed to load: ${result.error}`);
console.log(`[check-native-modules] Attempting rebuild...`);

if (!rebuild()) {
  console.error(`[check-native-modules] FATAL: rebuild failed`);
  process.exit(1);
}

const retry = tryLoad();
if (retry.ok) {
  console.log(`[check-native-modules] ${MODULE_NAME} OK after rebuild`);
  process.exit(0);
}

console.error(`[check-native-modules] FATAL: ${MODULE_NAME} still broken after rebuild: ${retry.error}`);
process.exit(1);
