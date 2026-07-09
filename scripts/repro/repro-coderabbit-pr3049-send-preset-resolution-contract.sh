#!/usr/bin/env bash
set -euo pipefail

# CodeRabbit PR #3049 (packages/app/src/in-app-planner.ts):
# sendPlanningChatMessage resolves harness presets BEFORE its try/catch:
#   const presets = await resolveHarnessPresets(deps.config);
#   const defaultPresetKey = await resolveDefaultPresetKey(deps.config);
# If either throws (e.g. a malformed `slackHarnessPresets` config), the promise
# REJECTS instead of returning the declared InAppPlanningChatResponse
# `{ ok: false, error }` shape — unlike every other failure path in the function.
# Downstream (main.ts GUI mutation handler) that surfaces as a raw IPC rejection
# instead of the structured `.ok` response the renderer branches on.
#
# This repro drives sendPlanningChatMessage with a config whose
# `slackHarnessPresets` getter throws:
#   - Buggy (resolution outside try) -> the call REJECTS -> vitest FAIL -> repro FAIL.
#   - Fixed (resolution inside try)   -> returns { ok: false, error } -> repro PASS.

REPO_ROOT="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
APP_DIR="$REPO_ROOT/packages/app"
VITEST="$APP_DIR/node_modules/.bin/vitest"

if [[ ! -x "$VITEST" ]]; then
  echo "[repro] FAIL: no vitest binary at $VITEST; run 'pnpm install' at the repo root first."
  exit 1
fi

SLUG=".repro-coderabbit-pr3049-send-preset-resolution-contract"
TEST_DIR="$APP_DIR/$SLUG"
TEST_FILE="$TEST_DIR/repro.test.ts"
mkdir -p "$TEST_DIR"
trap 'rm -rf "$TEST_DIR"' EXIT

cat > "$TEST_FILE" <<'TS'
import { describe, it, expect } from 'vitest';
import {
  createInAppPlanningChatSessions,
  sendPlanningChatMessage,
} from '../src/in-app-planner.js';

describe('sendPlanningChatMessage preset-resolution contract', () => {
  it('returns { ok: false } instead of rejecting when preset resolution throws', async () => {
    const sessions = createInAppPlanningChatSessions();
    const config: Record<string, unknown> = {};
    // A malformed harness-preset config surfaces here: accessing the field throws.
    Object.defineProperty(config, 'slackHarnessPresets', {
      enumerable: true,
      get() {
        throw new Error('malformed slackHarnessPresets');
      },
    });

    // On the buggy code this rejects (resolution runs before the try), so the
    // await throws and the test fails. The declared contract is a resolved
    // { ok: false, error } response for every failure path.
    const result = await sendPlanningChatMessage(
      { message: 'plan the feature', presetKey: 'codex' } as never,
      {
        config: config as never,
        loadGeneratedPlan: async () => ({ planName: 'x', workflowId: 'y' }),
        sessions,
        planningCommandBuilder: () => ({ command: 'planner', args: [] }),
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('malformed slackHarnessPresets');
    }
    // A failed resolution must not have created a session.
    expect(sessions.size).toBe(0);
  });
});
TS

set +e
( cd "$APP_DIR" && "$VITEST" run --reporter=dot "$SLUG/repro.test.ts" )
CODE=$?
set -e

if [[ "$CODE" -ne 0 ]]; then
  echo "[repro] FAIL: sendPlanningChatMessage lets preset-resolution failures escape the { ok: false } contract (vitest exit $CODE)."
  exit 1
fi

echo "[repro] PASS: sendPlanningChatMessage returns a structured { ok: false, error } response when preset resolution throws."
exit 0
