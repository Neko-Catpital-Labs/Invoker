#!/usr/bin/env node
'use strict';

const { createRequire } = require('node:module');
const { existsSync, readFileSync, statSync } = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const appDir = path.join(repoRoot, 'packages', 'app');
const appPackageJson = path.join(appDir, 'package.json');
const platformArch = `${process.platform}-${process.arch}`;

function modeString(mode) {
  return `0o${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readPackageName(packageDir) {
  const packageJsonPath = path.join(packageDir, 'package.json');
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  return parsed.name;
}

function findNodePtyPackageRoot(entryPath) {
  let current = path.dirname(entryPath);
  while (current !== path.dirname(current)) {
    const packageJsonPath = path.join(current, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
        if (parsed.name === 'node-pty') return current;
      } catch {
        // Keep walking; a malformed unrelated package.json should not mask the
        // actual resolution failure below.
      }
    }
    current = path.dirname(current);
  }
  throw new Error(`resolved entry is not inside a node-pty package: ${entryPath}`);
}

function resolveNodePtyPackageRoot() {
  const overrideDir = process.env.INVOKER_VERIFY_NODE_PTY_PACKAGE_DIR;
  if (overrideDir) {
    const packageDir = path.resolve(overrideDir);
    const packageName = readPackageName(packageDir);
    if (packageName !== 'node-pty') {
      throw new Error(
        `INVOKER_VERIFY_NODE_PTY_PACKAGE_DIR must point at node-pty, got ${packageName}`,
      );
    }
    return packageDir;
  }

  const appRequire = createRequire(appPackageJson);
  const entryPath = appRequire.resolve('node-pty');
  return findNodePtyPackageRoot(entryPath);
}

function main() {
  let nodePtyDir;
  try {
    nodePtyDir = resolveNodePtyPackageRoot();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error('ERROR: node-pty is not resolvable from @invoker/app.');
    console.error(`@invoker/app directory: ${appDir}`);
    console.error(`Reason: ${reason}`);
    console.error('Run pnpm install from the repository root.');
    process.exit(1);
  }

  const helperPath = path.join(nodePtyDir, 'prebuilds', platformArch, 'spawn-helper');
  if (!existsSync(helperPath)) {
    console.log(
      `node-pty install check: no prebuilt spawn-helper for ${platformArch}; skipping permission check.`,
    );
    return;
  }

  const stat = statSync(helperPath);
  const executable = (stat.mode & 0o111) !== 0;
  if (executable) {
    console.log(`node-pty install check: spawn-helper is executable (${helperPath}).`);
    return;
  }

  console.error('ERROR: node-pty spawn-helper is not executable.');
  console.error(`Helper path: ${helperPath}`);
  console.error(`Current mode: ${modeString(stat.mode)}`);
  console.error('Expected mode: 0o755 (or any mode with an execute bit set)');
  console.error('Manual remediation:');
  console.error(`  chmod 755 ${shellQuote(helperPath)}`);
  console.error('  pnpm install');
  process.exit(1);
}

main();
