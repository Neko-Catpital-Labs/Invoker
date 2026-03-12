#!/usr/bin/env node
'use strict';

/**
 * Rebuild better-sqlite3 for Electron's ABI.
 *
 * Runs check-native-modules.js under Electron's bundled Node.js
 * (ELECTRON_RUN_AS_NODE=1) so the binary is compiled for Electron's ABI
 * rather than system Node's ABI.
 *
 * Called automatically by `postinstall` and available as `pnpm run rebuild:electron`.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.join(__dirname, '..');
const ELECTRON_BIN = path.join(REPO_ROOT, 'packages', 'app', 'node_modules', '.bin', 'electron');
const CHECK_SCRIPT = path.join(__dirname, 'check-native-modules.js');

if (!fs.existsSync(ELECTRON_BIN)) {
  console.log('[rebuild-for-electron] Electron binary not found — skipping (will be available after install completes)');
  process.exit(0);
}

if (!fs.existsSync(CHECK_SCRIPT)) {
  console.error('[rebuild-for-electron] check-native-modules.js not found');
  process.exit(1);
}

console.log('[rebuild-for-electron] Rebuilding better-sqlite3 for Electron ABI...');

try {
  execSync(`"${ELECTRON_BIN}" "${CHECK_SCRIPT}"`, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  console.log('[rebuild-for-electron] Done');
} catch (err) {
  console.error('[rebuild-for-electron] Failed:', err.message);
  process.exit(1);
}
