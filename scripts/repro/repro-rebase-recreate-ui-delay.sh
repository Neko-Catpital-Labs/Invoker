#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$ROOT"
EXPECTATION="fixed"

usage() {
  echo "usage: $0 [--expect-bug|--expect-fixed]" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-bug)
      EXPECTATION="bug"
      shift
      ;;
    --expect-fixed)
      EXPECTATION="fixed"
      shift
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

TEST_PATH_REL="packages/ui/src/__tests__/rebase-recreate-ui-delay.repro.test.tsx"
TEST_PATH="$ROOT/$TEST_PATH_REL"
VITEST_PATH="src/__tests__/rebase-recreate-ui-delay.repro.test.tsx"
cleanup() {
  rm -f "$TEST_PATH"
}
trap cleanup EXIT

cat >"$TEST_PATH" <<'TS'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

const task = makeUITask({
  id: 'task-delay',
  description: 'Delay repro task',
  status: 'pending',
  command: 'echo delay',
  workflowId: 'wf-delay',
});

const workflows: WorkflowMeta[] = [
  { id: 'wf-delay', name: 'Delay Workflow', status: 'running', baseBranch: 'main' },
];

describe('rebase recreate pending UI repro', () => {
  let mock: MockInvoker;
  let finishRebase: (value: { success: true; rebasedBranches: string[]; errors: string[] }) => void;
  let pendingRebase: Promise<{ success: true; rebasedBranches: string[]; errors: string[] }>;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
    pendingRebase = new Promise((resolve) => {
      finishRebase = resolve;
    });
    vi.mocked(mock.api.rebaseRecreate).mockImplementation(() => pendingRebase);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mock.cleanup();
  });

  async function issueRebaseRecreate() {
    render(<App />);
    act(() => mock.setTasks([task], workflows));
    await waitFor(() => expect(screen.getByTestId('workflow-node-wf-delay')).toBeInTheDocument());
    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-delay'));
    fireEvent.click(await screen.findByText('More'));
    fireEvent.click(await screen.findByText('Rebase and Recreate'));
    await waitFor(() => expect(mock.api.rebaseRecreate).toHaveBeenCalledWith('wf-delay'));
  }

  it('bug: the click is accepted but no pending feedback is visible while IPC is unresolved', async () => {
    await issueRebaseRecreate();
    expect(screen.queryByTestId('workflow-action-notice')).not.toBeInTheDocument();
  });

  it('fixed: pending feedback appears immediately and clears when IPC resolves', async () => {
    await issueRebaseRecreate();
    expect(await screen.findByTestId('workflow-action-notice')).toHaveTextContent('Rebase and Recreate started');
    expect(screen.getByTestId('workflow-action-notice')).toHaveTextContent('Delay Workflow will update when this finishes.');

    await act(async () => {
      finishRebase({ success: true, rebasedBranches: [], errors: [] });
      await pendingRebase;
    });
    await waitFor(() => expect(screen.queryByTestId('workflow-action-notice')).not.toBeInTheDocument());
  });
});
TS

case "$EXPECTATION" in
  bug)
    echo "[repro] expecting buggy behavior: accepted click with no pending UI"
    pnpm --filter @invoker/ui exec vitest run "$VITEST_PATH" -t "bug:"
    ;;
  fixed)
    echo "[repro] expecting fixed behavior: pending UI appears until rebase recreate resolves"
    pnpm --filter @invoker/ui exec vitest run "$VITEST_PATH" -t "fixed:"
    ;;
esac

echo "[repro] passed"
