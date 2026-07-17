#!/usr/bin/env bash
set -euo pipefail

# Bug-only repro for CodeRabbit PR #3050 (discussion r3523490880).
#
# The renderer bug: the "run" text command called handleStart() without the
# hasStarted guard used by the Start button, so typing "run" again re-invoked
# invoker.start() for the same submitted plan.
#
# Exit codes:
#   0  the intended bug reproduced
#   1  the focused test passed, so the bug did not reproduce
#   2  repro setup failed or Vitest failed for an unrelated reason

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
UI_DIR="$REPO_ROOT/packages/ui"
TEST_FILE="$(mktemp "$UI_DIR/src/__tests__/tmp-repro-pr3050-run-guard.XXXXXX.test.tsx")"
TEST_NAME="$(basename "$TEST_FILE")"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-pr3050-run-guard.XXXXXX.log")"
BUG_SENTINEL="REPRO_BUG_PR3050_RUN_GUARD"

cleanup() {
  rm -f "$TEST_FILE" "$LOG_FILE"
}
trap cleanup EXIT

cat > "$TEST_FILE" <<'TS'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { InAppPlanningChatResponse } from '@invoker/contracts';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

describe('PR #3050 run-command guard bug repro', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  async function openPlanningTerminal() {
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });
  }

  function submitPlanningText(text: string) {
    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: text } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
  }

  it('does not re-invoke start after a run has already started', async () => {
    const draftReply: InAppPlanningChatResponse = {
      ok: true,
      sessionId: 'session-1',
      reply: 'Here is the plan.',
      draftPlanAvailable: true,
      draftPlanSummary: { name: 'Mock Plan', taskCount: 2, steps: ['First', 'Second'] },
    };
    mock.api.planningChatSend = vi.fn(async () => draftReply);

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('draft the full plan');
    await screen.findByTestId('invoker-terminal-ready-bar');
    fireEvent.click(screen.getByRole('button', { name: 'Submit to Invoker' }));
    await waitFor(() => {
      expect(mock.api.planningChatSubmit).toHaveBeenCalledTimes(1);
    });

    await openPlanningTerminal();
    const input = screen.getByTestId('invoker-terminal-input') as HTMLTextAreaElement;
    if (input.disabled) {
      return;
    }

    submitPlanningText('run');
    await waitFor(() => {
      expect(mock.api.start).toHaveBeenCalledTimes(1);
    });

    submitPlanningText('run');
    await Promise.resolve();

    if (mock.api.start.mock.calls.length > 1) {
      throw new Error('REPRO_BUG_PR3050_RUN_GUARD: second run text command re-invoked invoker.start');
    }

    await screen.findByText('Run already started.');
  });
});
TS

echo "[repro] PR #3050: proving repeated 'run' text commands re-invoke start only when the bug is present."

set +e
pnpm -C "$REPO_ROOT" --filter @invoker/ui exec vitest run \
  --reporter=verbose \
  "src/__tests__/$TEST_NAME" \
  >"$LOG_FILE" 2>&1
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  echo "[repro] FAIL: focused run-guard test passed; the bug did not reproduce."
  exit 1
fi

if grep -Fq "$BUG_SENTINEL" "$LOG_FILE"; then
  echo "[repro] PASS: a second 'run' text command re-invoked invoker.start()."
  exit 0
fi

echo "[repro] ERROR: Vitest failed, but not with the intended run-guard bug." >&2
cat "$LOG_FILE" >&2
exit 2
