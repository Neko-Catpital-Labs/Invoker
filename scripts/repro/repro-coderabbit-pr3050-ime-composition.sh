#!/usr/bin/env bash
set -euo pipefail

# Bug-only repro for CodeRabbit PR #3050 (discussion r3523490884).
#
# The renderer bug: Enter-to-submit ignored nativeEvent.isComposing, so the
# Enter key used to confirm an IME candidate submitted a half-composed message.
#
# Exit codes:
#   0  the intended bug reproduced
#   1  the focused test passed, so the bug did not reproduce
#   2  repro setup failed or Vitest failed for an unrelated reason

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
UI_DIR="$REPO_ROOT/packages/ui"
TEST_FILE="$(mktemp "$UI_DIR/src/__tests__/tmp-repro-pr3050-ime-composition.XXXXXX.test.tsx")"
TEST_NAME="$(basename "$TEST_FILE")"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-pr3050-ime-composition.XXXXXX.log")"
BUG_SENTINEL="REPRO_BUG_PR3050_IME_COMPOSITION"

cleanup() {
  rm -f "$TEST_FILE" "$LOG_FILE"
}
trap cleanup EXIT

cat > "$TEST_FILE" <<'TS'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

describe('PR #3050 IME composition bug repro', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  async function openPlanningTerminal() {
    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });
  }

  it('does not submit while an IME composition is in progress', async () => {
    await openPlanningTerminal();

    const input = screen.getByTestId('invoker-terminal-input');
    fireEvent.change(input, { target: { value: 'composition candidate' } });

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    await Promise.resolve();

    if (mock.api.planningChatSend.mock.calls.length > 0) {
      throw new Error('REPRO_BUG_PR3050_IME_COMPOSITION: Enter submitted while nativeEvent.isComposing was true');
    }

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({
        message: 'composition candidate',
        presetKey: 'codex',
      });
    });
  });
});
TS

echo "[repro] PR #3050: proving Enter-to-submit ignores IME composition only when the bug is present."

set +e
pnpm -C "$REPO_ROOT" --filter @invoker/ui exec vitest run \
  --reporter=verbose \
  "src/__tests__/$TEST_NAME" \
  >"$LOG_FILE" 2>&1
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  echo "[repro] FAIL: focused IME composition test passed; the bug did not reproduce."
  exit 1
fi

if grep -Fq "$BUG_SENTINEL" "$LOG_FILE"; then
  echo "[repro] PASS: Enter during IME composition submitted the in-progress text."
  exit 0
fi

echo "[repro] ERROR: Vitest failed, but not with the intended IME composition bug." >&2
cat "$LOG_FILE" >&2
exit 2
