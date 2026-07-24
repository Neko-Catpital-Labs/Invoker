#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
TARGET="$ROOT/packages/execution-engine/src/agent-prompt-transport.ts"

echo "[repro] problem: spilled workflow prompt cleanup failures must be observable"
echo "[repro] check: materializeLocalAgentPrompt cleanup returns the directory and original rmSync error"

node - "$TARGET" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const targetPath = process.argv[2];
let source = fs.readFileSync(targetPath, 'utf8');
source = source
  .replace("import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';", "const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');")
  .replace("import { tmpdir } from 'node:os';", "const { tmpdir } = require('node:os');")
  .replace("import { join } from 'node:path';", "const { join } = require('node:path');")
  .replace(/export interface LocalPromptCleanupResult \{[\s\S]*?\n\}\n\n/, '')
  .replace(/export interface LocalPromptTransport \{[\s\S]*?\n\}\n\n/, '')
  .replace('export const DEFAULT_MAX_INLINE_AGENT_PROMPT_BYTES = 64 * 1024;', 'const DEFAULT_MAX_INLINE_AGENT_PROMPT_BYTES = 64 * 1024;')
  .replace('export function maxInlineAgentPromptBytes(): number {', 'function maxInlineAgentPromptBytes() {')
  .replace('export function shouldInlineAgentPrompt(prompt: string): boolean {', 'function shouldInlineAgentPrompt(prompt) {')
  .replace('export function buildAgentPromptFileBootstrap(promptPath: string): string {', 'function buildAgentPromptFileBootstrap(promptPath) {')
  .replace('function removePromptDirectory(directory: string): LocalPromptCleanupResult | undefined {', 'function removePromptDirectory(directory) {')
  .replace("export function materializeLocalAgentPrompt(\n  prompt: string,\n  directoryPrefix: string = 'invoker-agent-prompt-',\n): LocalPromptTransport {", "function materializeLocalAgentPrompt(\n  prompt,\n  directoryPrefix = 'invoker-agent-prompt-',\n) {");
source += '\nmodule.exports = { materializeLocalAgentPrompt };\n';

const cleanupError = new Error('simulated rmSync cleanup failure');
const createdDirectory = '/tmp/invoker-agent-prompt-repro-5678';

const sandbox = {
  require(specifier) {
    if (specifier === 'node:fs') {
      return {
        mkdtempSync: () => createdDirectory,
        rmSync: () => {
          throw cleanupError;
        },
        writeFileSync: () => {},
      };
    }
    if (specifier === 'node:os') {
      return { tmpdir: () => '/tmp' };
    }
    if (specifier === 'node:path') {
      return path;
    }
    throw new Error(`unexpected import: ${specifier}`);
  },
  module: { exports: {} },
  exports: {},
  Buffer,
  console,
  process: { env: {} },
  globalThis: null,
};
sandbox.globalThis = sandbox;
vm.runInNewContext(source, sandbox, { filename: targetPath });

const { materializeLocalAgentPrompt } = sandbox.module.exports;
const transport = materializeLocalAgentPrompt('running task details\n'.repeat(10_000));
const result = transport.cleanup();

if (!result) {
  console.error('[repro] FAIL: cleanup swallowed the rmSync failure and returned no result');
  process.exit(1);
}
if (result.directory !== createdDirectory) {
  console.error(`[repro] FAIL: cleanup reported directory ${result.directory} instead of ${createdDirectory}`);
  process.exit(1);
}
if (!result.error || typeof result.error.message !== 'string' || !result.error.message.includes(cleanupError.message)) {
  console.error('[repro] FAIL: cleanup did not report the rmSync failure message');
  process.exit(1);
}

console.log('[repro] PASS: cleanup failures surface the original rmSync error and directory');
NODE
