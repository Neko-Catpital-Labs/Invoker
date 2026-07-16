#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

config_path="packages/app/playwright.config.ts"

echo "[repro] Running PR #4773 fractional Playwright retries regression."
echo "[repro] Scenario: INVOKER_PLAYWRIGHT_RETRIES=1.5 must normalize to 0, not pass 1.5 to Playwright."

node --input-type=module - "$config_path" <<'NODE'
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const configPath = process.argv[2];
const source = readFileSync(configPath, 'utf8');
const executableConfig = source
  .replace(/^import .*?;\n/gm, '')
  .replace('export default defineConfig({', 'globalThis.__playwrightConfig = defineConfig({')
  + '\nglobalThis.__playwrightConfig;\n';

function loadRetries(env) {
  const context = {
    process: { env: { ...env } },
    mkdtempSync: () => '/tmp/invoker-e2e-browser-registry-repro',
    tmpdir: () => '/tmp',
    path: { join: (...parts) => parts.join('/') },
    defineConfig: (config) => config,
    E2E_BROWSER_REGISTRY_ENV: 'INVOKER_E2E_BROWSER_REGISTRY',
  };
  return vm.runInNewContext(executableConfig, context, { filename: configPath }).retries;
}

const fractionalRetries = loadRetries({ INVOKER_PLAYWRIGHT_RETRIES: '1.5' });
if (fractionalRetries !== 0) {
  console.error(`[repro] FAIL: fractional retry count reached Playwright as ${fractionalRetries}; expected 0.`);
  process.exit(1);
}

const integerRetries = loadRetries({ INVOKER_PLAYWRIGHT_RETRIES: '2' });
if (integerRetries !== 2) {
  console.error(`[repro] FAIL: integer retry count resolved to ${integerRetries}; expected 2.`);
  process.exit(1);
}

console.log('[repro] PASS: fractional retry counts are rejected while integer retry counts still work.');
NODE