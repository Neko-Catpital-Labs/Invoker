#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
TARGET="$ROOT/packages/execution-engine/src/agent-prompt-transport.ts"

echo "[repro] problem: oversized prompt materialization must remove its temp dir when writing prompt.md fails"
echo "[repro] check: materializeLocalAgentPrompt cleans up the created directory before rethrowing the write error"

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
  .replace("export interface LocalPromptTransport {\n  effectivePrompt: string;\n  cleanup: () => void;\n}\n\n", '')
  .replace('export const DEFAULT_MAX_INLINE_AGENT_PROMPT_BYTES = 64 * 1024;', 'const DEFAULT_MAX_INLINE_AGENT_PROMPT_BYTES = 64 * 1024;')
  .replace('export function maxInlineAgentPromptBytes(): number {', 'function maxInlineAgentPromptBytes() {')
  .replace('export function shouldInlineAgentPrompt(prompt: string): boolean {', 'function shouldInlineAgentPrompt(prompt) {')
  .replace('export function buildAgentPromptFileBootstrap(promptPath: string): string {', 'function buildAgentPromptFileBootstrap(promptPath) {')
  .replace("export function materializeLocalAgentPrompt(\n  prompt: string,\n  directoryPrefix: string = 'invoker-agent-prompt-',\n): LocalPromptTransport {", "function materializeLocalAgentPrompt(\n  prompt,\n  directoryPrefix = 'invoker-agent-prompt-',\n) {");
source += '\nmodule.exports = { materializeLocalAgentPrompt };\n';

const createdDirectory = '/tmp/invoker-agent-prompt-repro-1234';
const rmCalls = [];
const writeError = new Error('simulated prompt write failure');

const sandbox = {
  require(specifier) {
    if (specifier === 'node:fs') {
      return {
        mkdtempSync: () => createdDirectory,
        rmSync: (target, options) => rmCalls.push({ target, options }),
        writeFileSync: () => {
          throw writeError;
        },
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
let thrown;
try {
  materializeLocalAgentPrompt('running task details\n'.repeat(10_000));
} catch (error) {
  thrown = error;
}

if (thrown !== writeError) {
  console.error('[repro] FAIL: materializeLocalAgentPrompt did not rethrow the original write failure');
  process.exit(1);
}
if (rmCalls.length !== 1) {
  console.error(`[repro] FAIL: expected one cleanup call after the write failure, saw ${rmCalls.length}`);
  process.exit(1);
}
if (rmCalls[0].target !== createdDirectory) {
  console.error(`[repro] FAIL: cleanup targeted ${rmCalls[0].target} instead of ${createdDirectory}`);
  process.exit(1);
}
if (!rmCalls[0].options?.recursive || !rmCalls[0].options?.force) {
  console.error('[repro] FAIL: cleanup did not remove the temp directory recursively with force=true');
  process.exit(1);
}

console.log('[repro] PASS: write failures clean up the prompt temp directory before rethrowing');
NODE
