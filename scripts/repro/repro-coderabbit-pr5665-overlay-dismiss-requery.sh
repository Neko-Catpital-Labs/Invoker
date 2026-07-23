#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

spec_path="packages/app/e2e/ui-graph-drag-performance.spec.ts"

echo "[repro] Running PR #5665 overlay dismiss re-query regression."
echo "[repro] Scenario: dismissKnownOverlays must keep dismissing visible overlay buttons after earlier buttons remove themselves."

node --input-type=module - "$spec_path" <<'NODE'
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const specPath = process.argv[2];
const source = readFileSync(specPath, 'utf8');
const match = source.match(/async function dismissKnownOverlays\(page: Page\): Promise<void> \{[\s\S]*?^\}/m);
if (!match) {
  console.error('[repro] FAIL: could not locate dismissKnownOverlays in target spec.');
  process.exit(1);
}

const executable = `${match[0]
  .replace('(page: Page)', '(page)')
  .replace('): Promise<void>', ')')}
this.__dismissKnownOverlays = dismissKnownOverlays;`;

const context = { console };
vm.runInNewContext(executable, context, { filename: specPath });
const dismissKnownOverlays = context.__dismissKnownOverlays;

const state = {
  buttons: [
    { name: 'Dismiss', visible: true },
    { name: 'Close', visible: true },
  ],
  clicks: [],
};

function buttonAt(index) {
  return {
    async isVisible() {
      return Boolean(state.buttons[index]?.visible);
    },
    async dispatchEvent(type) {
      if (type !== 'click') {
        throw new Error(`unexpected event: ${type}`);
      }
      const button = state.buttons[index];
      if (!button) {
        throw new Error(`missing button at dynamic index ${index}`);
      }
      state.clicks.push(button.name);
      state.buttons.splice(index, 1);
    },
    async click() {
      const button = state.buttons[index];
      if (!button) {
        throw new Error(`missing button at dynamic index ${index}`);
      }
      state.clicks.push(button.name);
      state.buttons.splice(index, 1);
    },
  };
}

const page = {
  getByRole(role, options) {
    if (role !== 'button') {
      throw new Error(`unexpected role: ${role}`);
    }
    const matcher = options?.name;
    const matchingIndexes = () => state.buttons
      .map((button, index) => ({ button, index }))
      .filter(({ button }) => matcher.test(button.name))
      .map(({ index }) => index);
    return {
      async count() {
        return matchingIndexes().length;
      },
      nth(queryIndex) {
        return buttonAt(matchingIndexes()[queryIndex]);
      },
    };
  },
};

await dismissKnownOverlays(page);

if (state.buttons.length !== 0) {
  console.error(`[repro] FAIL: ${state.buttons.length} dismissible overlay button(s) remained after dismissKnownOverlays: ${state.buttons.map((button) => button.name).join(', ')}.`);
  process.exit(1);
}

if (state.clicks.join(',') !== 'Dismiss,Close') {
  console.error(`[repro] FAIL: expected dismiss order Dismiss,Close; saw ${state.clicks.join(',') || '(none)'}.`);
  process.exit(1);
}

console.log('[repro] PASS: dismissKnownOverlays re-queries dismiss buttons until none remain.');
NODE
