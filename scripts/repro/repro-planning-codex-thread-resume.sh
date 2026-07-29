#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-}"
case "$MODE" in
  --expect-bug)
    EXPECT_MODE="bug"
    ;;
  --expect-fixed)
    EXPECT_MODE="fixed"
    ;;
  *)
    echo "usage: $0 --expect-bug|--expect-fixed" >&2
    exit 64
    ;;
esac

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SURFACES_DIR="$REPO_ROOT/packages/surfaces"
VITEST="$SURFACES_DIR/node_modules/.bin/vitest"

if [[ ! -x "$VITEST" ]]; then
  echo "[repro] FAIL: no vitest binary at $VITEST; run 'pnpm install' at the repo root first." >&2
  exit 1
fi

TEST_FILE="$SURFACES_DIR/src/__tests__/.repro-planning-codex-thread-resume.test.ts"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-planning-codex-thread-resume.XXXXXX.log")"
trap 'rm -f "$TEST_FILE" "$LOG_FILE"' EXIT

cat > "$TEST_FILE" <<'TS'
import { describe, it, expect, vi } from 'vitest';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PlanConversation } from '../slack/plan-conversation.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const mockSpawn = vi.mocked(childProcess.spawn);

function createMockProcess(stdout: string): any {
  const proc = new EventEmitter() as any;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  proc.stdout = stdoutEmitter;
  proc.stderr = stderrEmitter;
  proc.kill = vi.fn();

  setTimeout(() => {
    stdoutEmitter.emit('data', Buffer.from(stdout));
    proc.emit('close', 0);
  }, 0);

  return proc;
}

describe('standalone planning Codex thread resume repro', () => {
  it('uses the provider thread id, not Invoker provisional UUID, for the second turn', async () => {
    const expectedMode = process.env.REPRO_EXPECT_MODE;
    const provisionalSessionId = 'cbbd3ce4-28ba-4b3d-8c25-8bafddc41177';
    const providerThreadId = '019d-real-codex-thread';

    let started = false;
    const driver = {
      harness: 'codex',
      supportsSessionContinuity: true,
      start: vi.fn((_prompt: string) => {
        started = true;
        return {
          command: 'fake-codex',
          args: ['exec', '--json'],
          sessionId: provisionalSessionId,
        };
      }),
      append: vi.fn((sessionId: string, _prompt: string) => ({
        command: 'fake-codex',
        args: ['exec', 'resume', sessionId],
        sessionId,
      })),
      resolveSessionId: vi.fn((rawStdout: string, command: { sessionId: string }, options: { startedNewSession: boolean }) => {
        if (!options.startedNewSession) return command.sessionId;
        const match = rawStdout.match(/"thread_id":"([^"]+)"/);
        return match?.[1] ?? command.sessionId;
      }),
    };

    const logs: string[] = [];
    const conv = new PlanConversation({
      harnessSessionDriver: driver,
      log: (_source, _level, message) => logs.push(message),
    });

    mockSpawn.mockReturnValueOnce(createMockProcess([
      JSON.stringify({ type: 'thread.started', thread_id: providerThreadId }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first turn ok' } }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n')));
    await conv.sendMessage('first planning message');

    expect(started).toBe(true);
    expect(conv.harnessSessionId).toBe(expectedMode === 'bug' ? provisionalSessionId : providerThreadId);

    mockSpawn.mockReturnValueOnce(createMockProcess('second turn ok'));
    await conv.sendMessage('continue planning');

    const resumedWith = driver.append.mock.calls[0]?.[0];
    if (expectedMode === 'bug') {
      expect(resumedWith).toBe(provisionalSessionId);
      return;
    }

    expect(resumedWith).toBe(providerThreadId);
    expect(resumedWith).not.toBe(provisionalSessionId);
    expect(logs.some((line) => line.includes('planner_session_id_promoted'))).toBe(true);
  });
});
TS

set +e
(
  cd "$SURFACES_DIR"
  REPRO_EXPECT_MODE="$EXPECT_MODE" "$VITEST" run --reporter=dot "src/__tests__/$(basename "$TEST_FILE")"
) >"$LOG_FILE" 2>&1
CODE=$?
set -e

if [[ "$CODE" -ne 0 ]]; then
  echo "[repro] FAIL: planning Codex thread resume invariant did not match $MODE."
  cat "$LOG_FILE"
  exit "$CODE"
fi

if [[ "$EXPECT_MODE" == "bug" ]]; then
  echo "[repro] PASS: reproduced bug; second turn resumed with the provisional Invoker UUID."
else
  echo "[repro] PASS: fixed; second turn resumed with the real Codex thread id."
fi
