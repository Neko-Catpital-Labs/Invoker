#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

node - "packages/app/src/main.ts" <<'NODE'
const fs = require('node:fs');
const path = process.argv[2];
const source = fs.readFileSync(path, 'utf8');
function fail(message) {
  console.error(`[repro] FAIL: ${message}`);
  process.exit(1);
}
const handlerNeedle = "ipcMain.handle(\n        'invoker:set-test-plan-from-goal-response'";
const handlerStart = source.indexOf(handlerNeedle);
if (handlerStart === -1) fail('test-plan override IPC handler not found');
const handlerEnd = source.indexOf("\n      );", handlerStart);
const handler = source.slice(handlerStart, handlerEnd === -1 ? undefined : handlerEnd);
for (const required of [
  'if (!ownerMode)',
  "messageBus.request('headless.gui-mutation'",
  "channel: 'invoker:set-test-plan-from-goal-response'",
  'args: [response]',
  'return;',
]) {
  if (!handler.includes(required)) fail(`non-owner handler is missing ${required}`);
}
const standaloneCase = "case 'invoker:set-test-plan-from-goal-response':";
if (!source.includes(standaloneCase)) fail('standalone owner cannot receive delegated test-plan overrides');
const standaloneStart = source.indexOf(standaloneCase);
const standaloneEnd = source.indexOf("\n          case '", standaloneStart + standaloneCase.length);
const standalone = source.slice(standaloneStart, standaloneEnd === -1 ? undefined : standaloneEnd);
for (const required of [
  "process.env.NODE_ENV !== 'test'",
  'headlessTestPlanFromGoalResponse =',
  'return undefined',
]) {
  if (!standalone.includes(required)) fail(`standalone owner override handler is missing ${required}`);
}
const planFromGoalCase = "case 'invoker:plan-from-goal':";
const planStart = source.indexOf(planFromGoalCase);
if (planStart === -1) fail('standalone plan-from-goal handler not found');
const planEnd = source.indexOf("\n          case '", planStart + planFromGoalCase.length);
const planCase = source.slice(planStart, planEnd === -1 ? undefined : planEnd);
if (!planCase.includes('headlessTestPlanFromGoalResponse')) {
  fail('standalone plan-from-goal does not consume delegated test-plan override');
}
NODE

echo "[repro] PASS: test-plan override delegates to the owner process"
