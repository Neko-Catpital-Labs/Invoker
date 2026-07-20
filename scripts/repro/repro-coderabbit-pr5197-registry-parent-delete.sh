#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
TARGET="$ROOT/packages/app/e2e/global-teardown.ts"
echo "[repro] problem: global teardown must not recursively delete an arbitrary env-derived parent directory"
echo "[repro] check: only the Playwright-managed browser registry temp dir may be removed"
node - "$TARGET" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const targetPath = process.argv[2];
let source = fs.readFileSync(targetPath, 'utf8');
source = source
  .replace(/^import .*$/gm, '')
  .replace('export function isManagedBrowserRegistryPath(registryPath: string | undefined): boolean {', 'function isManagedBrowserRegistryPath(registryPath) {')
  .replace('export default async function globalTeardown(): Promise<void> {', 'async function globalTeardown() {');
source += '\nglobalThis.__exports = { globalTeardown, isManagedBrowserRegistryPath };\n';

const rmCalls = [];
const execCalls = [];
const context = {
  execFileSync: (...args) => execCalls.push(args),
  rmSync: (target, options) => rmCalls.push({ target, options }),
  tmpdir: () => '/tmp',
  path,
  process: {
    env: {},
    execPath: process.execPath,
  },
  __dirname: path.dirname(targetPath),
  E2E_BROWSER_REGISTRY_ENV: 'INVOKER_E2E_BROWSER_PROCESS_REGISTRY',
  console,
  globalThis: null,
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: targetPath });

const { globalTeardown, isManagedBrowserRegistryPath } = context.__exports;

(async () => {
  const unsafeRegistryPath = '/tmp/workspace/user-data-dirs.txt';
  context.process.env.INVOKER_E2E_BROWSER_PROCESS_REGISTRY = unsafeRegistryPath;
  await globalTeardown();
  if (rmCalls.length !== 0) {
    console.error(`[repro] FAIL: teardown tried to remove ${rmCalls[0].target} for unsafe registry path ${unsafeRegistryPath}`);
    process.exit(1);
  }
  if (execCalls.length !== 1) {
    console.error('[repro] FAIL: teardown did not invoke the cleanup script once for the unsafe path case');
    process.exit(1);
  }

  rmCalls.length = 0;
  const safeRegistryPath = '/tmp/invoker-e2e-browser-registry-abc123/user-data-dirs.txt';
  context.process.env.INVOKER_E2E_BROWSER_PROCESS_REGISTRY = safeRegistryPath;
  await globalTeardown();
  if (!isManagedBrowserRegistryPath(safeRegistryPath)) {
    console.error('[repro] FAIL: managed registry path was not recognized as safe to remove');
    process.exit(1);
  }
  if (rmCalls.length !== 1 || rmCalls[0].target !== '/tmp/invoker-e2e-browser-registry-abc123') {
    console.error('[repro] FAIL: teardown did not remove the managed registry temp dir');
    process.exit(1);
  }

  console.log('[repro] PASS: teardown skips arbitrary parents and still removes the managed registry dir');
})().catch((error) => {
  console.error(`[repro] FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
NODE
