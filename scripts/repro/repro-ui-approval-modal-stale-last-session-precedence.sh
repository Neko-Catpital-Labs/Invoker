#!/usr/bin/env bash
set -euo pipefail

# Bug-only repro for ApprovalModal approval-session precedence.
#
# The renderer bug: when task.execution.lastAgentSessionId is populated with a
# stale durable session, ApprovalModal uses it before consulting fresher
# task.awaiting_approval history for the current approval cycle.
#
# Exit codes:
#   0  the intended stale-last-session precedence bug reproduced
#   1  the focused test passed, so the bug did not reproduce
#   2  repro setup failed or Vitest failed for an unrelated reason

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
UI_DIR="$REPO_ROOT/packages/ui"
TEST_FILE="$(mktemp "$UI_DIR/src/__tests__/tmp-repro-ui-approval-modal-stale-last-session-precedence.XXXXXX.test.tsx")"
TEST_NAME="$(basename "$TEST_FILE")"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-ui-approval-modal-stale-last-session-precedence.XXXXXX.log")"
BUG_SENTINEL="REPRO_BUG_UI_APPROVAL_MODAL_STALE_LAST_SESSION_PRECEDENCE"

cleanup() {
  rm -f "$TEST_FILE" "$LOG_FILE"
}
trap cleanup EXIT

cat > "$TEST_FILE" <<'TS'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ApprovalModal } from '../components/ApprovalModal.js';
import type { TaskState } from '../types.js';

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'task-1',
    description: 'Approve repaired task',
    status: 'awaiting_approval',
    dependencies: [],
    createdAt: new Date(),
    config: {},
    execution: {},
    ...overrides,
  };
}

const mockGetAgentSession = vi.fn();
const mockGetEvents = vi.fn();

beforeEach(() => {
  mockGetAgentSession.mockReset();
  mockGetEvents.mockReset();
  mockGetAgentSession.mockResolvedValue([
    { role: 'assistant', content: 'Recovered session transcript.', timestamp: '' },
  ]);
  mockGetEvents.mockResolvedValue([
    {
      id: 1,
      taskId: 'task-1',
      eventType: 'task.awaiting_approval',
      payload: JSON.stringify({
        status: 'awaiting_approval',
        execution: {
          agentSessionId: 'stale-last-session-001',
          agentName: 'claude',
        },
      }),
      createdAt: '2026-04-16 21:10:37',
    },
    {
      id: 2,
      taskId: 'task-1',
      eventType: 'task.awaiting_approval',
      payload: JSON.stringify({
        status: 'awaiting_approval',
        execution: {
          agentSessionId: 'fresh-current-cycle-session-002',
          agentName: 'codex',
        },
      }),
      createdAt: '2026-04-17 05:21:35',
    },
  ]);
  (window as any).invoker = {
    getAgentSession: mockGetAgentSession,
    getEvents: mockGetEvents,
  };
});

afterEach(() => {
  delete (window as any).invoker;
});

describe('ApprovalModal stale lastAgentSessionId precedence repro', () => {
  it('consults the current approval-cycle event before using durable lastAgentSessionId', async () => {
    render(
      <ApprovalModal
        task={makeTask({
          execution: {
            pendingFixError: 'fix failed after rerun',
            lastAgentSessionId: 'stale-last-session-001',
            lastAgentName: 'claude',
          },
        })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
        initialAction="reject"
      />,
    );

    await waitFor(() => {
      expect(mockGetAgentSession).toHaveBeenCalled();
    });

    const staleSessionWasUsed = mockGetAgentSession.mock.calls.some(
      ([sessionId]) => sessionId === 'stale-last-session-001',
    );
    if (staleSessionWasUsed && mockGetEvents.mock.calls.length === 0) {
      throw new Error(
        'REPRO_BUG_UI_APPROVAL_MODAL_STALE_LAST_SESSION_PRECEDENCE: stale lastAgentSessionId won before approval history was consulted',
      );
    }

    await waitFor(() => {
      expect(mockGetEvents).toHaveBeenCalledWith('task-1');
      expect(mockGetAgentSession).toHaveBeenCalledWith('fresh-current-cycle-session-002', 'codex');
    });

    expect(screen.getByText('Codex Session')).toBeInTheDocument();
    expect(screen.getByText('fresh-current-cycle-session-002')).toBeInTheDocument();
    expect(screen.queryByText('stale-last-session-001')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue(
      'Codex session: fresh-current-cycle-session-002\nOriginal error: fix failed after rerun',
    );
  });
});
TS

echo "[repro] ApprovalModal: proving stale lastAgentSessionId wins over fresher approval history only when the bug is present."

set +e
pnpm -C "$REPO_ROOT" --filter @invoker/ui exec vitest run \
  --reporter=verbose \
  "src/__tests__/$TEST_NAME" \
  >"$LOG_FILE" 2>&1
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  echo "[repro] FAIL: focused approval-session precedence test passed; the bug did not reproduce."
  exit 1
fi

if grep -Fq "$BUG_SENTINEL" "$LOG_FILE"; then
  echo "[repro] PASS: stale lastAgentSessionId was used before fresher approval-cycle history."
  exit 0
fi

echo "[repro] ERROR: Vitest failed, but not with the intended approval-session precedence bug." >&2
cat "$LOG_FILE" >&2
exit 2
