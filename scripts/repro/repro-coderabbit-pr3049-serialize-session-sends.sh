#!/usr/bin/env bash
set -euo pipefail

# CodeRabbit PR #3049 (packages/app/src/in-app-planner.ts):
# sendPlanningChatMessage reuses one PlanConversation per session, and
# PlanConversation.sendMessage() mutates this.messages ACROSS an await
# (push user -> await spawnPlanner -> push assistant). Two overlapping
# requests for the same sessionId (double-click / retry / multi-tab) interleave
# turns: both user messages get pushed before either assistant reply lands, so
# the transcript ordering is corrupted and getDraftedPlan() can read the wrong
# conversation state.
#
# This repro creates a session, then fires two concurrent sends for the same
# sessionId with controlled planner-resolution order:
#   - Buggy (no serialization) -> history becomes user,user,assistant,assistant
#     (two consecutive user turns) -> vitest FAIL -> repro FAIL.
#   - Fixed (per-session serialization) -> history strictly alternates
#     user,assistant,user,assistant -> repro PASS.

REPO_ROOT="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
APP_DIR="$REPO_ROOT/packages/app"
VITEST="$APP_DIR/node_modules/.bin/vitest"

if [[ ! -x "$VITEST" ]]; then
  echo "[repro] FAIL: no vitest binary at $VITEST; run 'pnpm install' at the repo root first."
  exit 1
fi

SLUG=".repro-coderabbit-pr3049-serialize-session-sends"
TEST_DIR="$APP_DIR/$SLUG"
TEST_FILE="$TEST_DIR/repro.test.ts"
mkdir -p "$TEST_DIR"
trap 'rm -rf "$TEST_DIR"' EXIT

cat > "$TEST_FILE" <<'TS'
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PlanConversation } from '@invoker/surfaces';
import {
  createInAppPlanningChatSessions,
  sendPlanningChatMessage,
} from '../src/in-app-planner.js';

const planningCommandBuilder = () => ({ command: 'planner', args: ['prompt'] });

afterEach(() => {
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('sendPlanningChatMessage concurrency', () => {
  it('serializes concurrent sends for one session so transcripts do not interleave', async () => {
    const sessions = createInAppPlanningChatSessions();
    const deps = {
      config: {} as never,
      loadGeneratedPlan: async () => ({ planName: 'x', workflowId: 'y' }),
      sessions,
      planningCommandBuilder,
    };

    const first = deferred<string>();
    const second = deferred<string>();
    // Arrival barriers: resolved the instant each concurrent send actually
    // reaches its awaited spawnPlanner call. This replaces a wall-clock sleep,
    // so the repro never races a fixed timeout on a slow machine. Staged (not
    // "wait for both at once") because the fixed/serialized path only lets send
    // B reach the planner AFTER send A has completed — a combined barrier would
    // deadlock the passing case.
    const arrivedA = deferred<void>();
    const arrivedB = deferred<void>();
    let call = 0;
    vi.spyOn(PlanConversation.prototype, 'spawnPlanner').mockImplementation(() => {
      const idx = call++;
      if (idx === 0) return Promise.resolve('reply-0'); // session creation
      if (idx === 1) { arrivedA.resolve(); return first.promise; } // concurrent send A
      arrivedB.resolve(); // concurrent send B
      return second.promise;
    });

    // Create the session with a completed first turn.
    const created = await sendPlanningChatMessage(
      { message: 'kick off', presetKey: 'codex' } as never,
      deps,
    );
    if (!created.ok) throw new Error(created.error);
    const sessionId = created.sessionId;

    // Fire two overlapping sends for the SAME session.
    const pA = sendPlanningChatMessage({ sessionId, message: 'message A' } as never, deps);
    const pB = sendPlanningChatMessage({ sessionId, message: 'message B' } as never, deps);

    // Barrier, not sleep: release send A's reply only once it is provably
    // awaiting the planner, then release send B's reply once it too reaches the
    // planner. Under serialization send B arrives only after A finishes, so the
    // awaits proceed in that order; under the buggy interleave both arrive up
    // front. Either way there is no timing race.
    await arrivedA.promise;
    first.resolve('reply-A');
    await arrivedB.promise;
    second.resolve('reply-B');
    await Promise.all([pA, pB]);

    const session = sessions.get(sessionId);
    expect(session).toBeDefined();
    const roles = session!.conversation.history.map((m) => m.role);

    // A correctly serialized transcript strictly alternates user/assistant.
    for (let i = 1; i < roles.length; i++) {
      expect(roles[i], `roles interleaved: ${roles.join(',')}`).not.toBe(roles[i - 1]);
    }
    // Sanity: both concurrent turns landed.
    expect(roles.filter((r) => r === 'user').length).toBe(3);
    expect(roles.filter((r) => r === 'assistant').length).toBe(3);
  });
});
TS

set +e
( cd "$APP_DIR" && "$VITEST" run --reporter=dot "$SLUG/repro.test.ts" )
CODE=$?
set -e

if [[ "$CODE" -ne 0 ]]; then
  echo "[repro] FAIL: concurrent sends for one session interleave the PlanConversation transcript (vitest exit $CODE)."
  exit 1
fi

echo "[repro] PASS: concurrent sends for one session are serialized; the transcript stays strictly alternating."
exit 0
