import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApprovalModal } from '../components/ApprovalModal.js';
import type { TaskState } from '../types.js';

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'task-1',
    description: 'Run unit tests',
    status: 'awaiting_approval',
    dependencies: [],
    createdAt: new Date(),
    config: {},
    execution: {},
    ...overrides,
  };
}

// Mock window.invoker session fetchers
const mockGetClaudeSession = vi.fn();
const mockGetAgentSession = vi.fn();
const mockGetEvents = vi.fn();

beforeEach(() => {
  mockGetClaudeSession.mockReset();
  mockGetAgentSession.mockReset();
  mockGetEvents.mockReset();
  // Default: resolve with null (no session found)
  mockGetClaudeSession.mockResolvedValue(null);
  mockGetAgentSession.mockResolvedValue(null);
  mockGetEvents.mockResolvedValue([]);
  (window as any).invoker = {
    getClaudeSession: mockGetClaudeSession,
    getAgentSession: mockGetAgentSession,
    getEvents: mockGetEvents,
  };
});

afterEach(() => {
  delete (window as any).invoker;
});

describe('ApprovalModal', () => {
  // ── Generic approval (no pendingFixError) ──────────────────

  it('renders "Manual Approval Required" heading for generic approval', () => {
    render(
      <ApprovalModal
        task={makeTask()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Manual Approval Required')).toBeInTheDocument();
  });

  it('starts with empty rejection reason for generic approval', () => {
    render(
      <ApprovalModal
        task={makeTask()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // Textarea should not be visible until Reject is clicked
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('shows rejection textarea only after clicking Reject for generic approval', () => {
    render(
      <ApprovalModal
        task={makeTask()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Reject'));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('pre-fills rejection reason with session ID for generic approval with agentSessionId', () => {
    render(
      <ApprovalModal
        task={makeTask({
          execution: { agentSessionId: 'sess-generic-456' },
        })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // Textarea not visible initially for generic approval
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Reject'));
    expect(screen.getByRole('textbox')).toHaveValue('Claude session: sess-generic-456');
  });

  // ── Fix-with-agent approval (pendingFixError set) ─────────

  it('renders "Approve AI Fix" heading for fix-with-agent approval', () => {
    render(
      <ApprovalModal
        task={makeTask({
          execution: { pendingFixError: 'Test failed: expected 1 but got 2' },
        })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Approve AI Fix')).toBeInTheDocument();
  });

  it('pre-fills rejection reason with session and error for fix approval', () => {
    render(
      <ApprovalModal
        task={makeTask({
          execution: {
            pendingFixError: 'Test failed: expected 1 but got 2',
            agentSessionId: 'sess-abc-123',
          },
        })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
        initialAction="reject"
      />,
    );
    const textarea = screen.getByRole('textbox');
    expect(textarea).toHaveValue(
      'Claude session: sess-abc-123\nOriginal error: Test failed: expected 1 but got 2',
    );
  });

  it('pre-fills rejection reason with only error when no session ID', () => {
    render(
      <ApprovalModal
        task={makeTask({
          execution: { pendingFixError: 'Exit code 1' },
        })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
        initialAction="reject"
      />,
    );
    const textarea = screen.getByRole('textbox');
    expect(textarea).toHaveValue('Original error: Exit code 1');
  });

  it('shows rejection textarea immediately when initialAction is reject', () => {
    render(
      <ApprovalModal
        task={makeTask({
          execution: { pendingFixError: 'some error' },
        })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
        initialAction="reject"
      />,
    );
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('shows "Approve Fix" button for fix-approval task when initialAction is approve', () => {
    render(
      <ApprovalModal
        task={makeTask({
          execution: { pendingFixError: 'some error' },
        })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
        initialAction="approve"
      />,
    );
    expect(screen.getByText('Approve Fix')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('merge node with pendingFixError shows fix headline and Approve Fix, not merge/PR copy', () => {
    render(
      <ApprovalModal
        task={makeTask({
          config: { isMergeNode: true },
          execution: { pendingFixError: 'merge failed' },
        })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
        onFinish="pull_request"
      />,
    );
    expect(screen.getByRole('heading', { name: 'Approve AI Fix' })).toBeInTheDocument();
    expect(screen.getByText('Approve Fix')).toBeInTheDocument();
    expect(screen.getByText('Reject Fix')).toBeInTheDocument();
    expect(screen.queryByText('Confirm Pull Request')).not.toBeInTheDocument();
    expect(screen.queryByText('Confirm Create PR')).not.toBeInTheDocument();
  });

  // ── Context info blocks ──────────────────────────────

  it('renders only session block for fix approval with session ID and loads messages', async () => {
    mockGetAgentSession.mockResolvedValue([
      { role: 'user', content: 'Fix the test', timestamp: '' },
    ]);

    render(
      <ApprovalModal
        task={makeTask({
          execution: {
            pendingFixError: 'Test failed: expected 1 but got 2',
            agentSessionId: 'sess-abc-123',
          },
        })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // Should render only the Claude session block
    const sessionBlock = screen.getByTestId('claude-session-context');
    expect(sessionBlock).toBeInTheDocument();
    expect(sessionBlock).toHaveTextContent('sess-abc-123');

    // Wait for session messages to load
    await waitFor(() => {
      expect(screen.getByTestId('session-messages')).toBeInTheDocument();
    });
    expect(screen.getByText('Fix the test')).toBeInTheDocument();

    // Fix context block should not exist
    expect(screen.queryByTestId('fix-context')).not.toBeInTheDocument();
  });

  it('shows no context blocks for fix approval with only error when no session ID', () => {
    render(
      <ApprovalModal
        task={makeTask({
          execution: { pendingFixError: 'Exit code 1' },
        })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // No session block (no agentSessionId)
    expect(screen.queryByTestId('claude-session-context')).not.toBeInTheDocument();
    // No fix context block (removed in simplification)
    expect(screen.queryByTestId('fix-context')).not.toBeInTheDocument();
    // But should still show the heading and button for fix approval
    expect(screen.getByText('Approve AI Fix')).toBeInTheDocument();
    expect(screen.getByText('Approve Fix')).toBeInTheDocument();
  });

  it('renders session block for generic approval with agentSessionId', () => {
    render(
      <ApprovalModal
        task={makeTask({
          execution: { agentSessionId: 'sess-generic-456' },
        })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const sessionBlock = screen.getByTestId('claude-session-context');
    expect(sessionBlock).toBeInTheDocument();
    expect(sessionBlock).toHaveTextContent('sess-generic-456');
    expect(screen.queryByTestId('fix-context')).not.toBeInTheDocument();
  });

  it('does not render any context blocks for generic approval without session ID', () => {
    render(
      <ApprovalModal
        task={makeTask()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('claude-session-context')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fix-context')).not.toBeInTheDocument();
  });

  // ── Merge node approval ──────────────────────────────────

  it('renders "Approve Merge" heading for merge node approval', () => {
    render(
      <ApprovalModal
        task={makeTask({ config: { isMergeNode: true } })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Approve Merge' })).toBeInTheDocument();
  });

  it('shows "Approve Merge" button label for merge node', () => {
    render(
      <ApprovalModal
        task={makeTask({ config: { isMergeNode: true } })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // Heading + button both say "Approve Merge"
    expect(screen.getAllByText('Approve Merge')).toHaveLength(2);
  });

  it('shows "Reject Merge" button label for merge node', () => {
    render(
      <ApprovalModal
        task={makeTask({ config: { isMergeNode: true } })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Reject Merge')).toBeInTheDocument();
  });

  it('shows "Confirm Reject Merge" after clicking Reject Merge for merge node', () => {
    render(
      <ApprovalModal
        task={makeTask({ config: { isMergeNode: true } })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Reject Merge'));
    expect(screen.getByText('Confirm Reject Merge')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  // ── Claude session conversation loading ─────────────────────

  it('shows loading state while fetching session conversation', () => {
    // Never resolve to keep loading state visible
    mockGetAgentSession.mockReturnValue(new Promise(() => {}));

    render(
      <ApprovalModal
        task={makeTask({
          execution: { agentSessionId: 'sess-loading-test' },
        })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('session-loading')).toBeInTheDocument();
    expect(screen.getByTestId('session-loading')).toHaveTextContent('Loading conversation...');
  });

  it('renders conversation messages after loading', async () => {
    mockGetAgentSession.mockResolvedValue([
      { role: 'user', content: 'Please fix the failing test', timestamp: '2025-01-01T00:00:00Z' },
      { role: 'assistant', content: 'I found the issue and fixed it.', timestamp: '2025-01-01T00:00:01Z' },
    ]);

    render(
      <ApprovalModal
        task={makeTask({
          execution: { agentSessionId: 'sess-conv-test' },
        })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('session-messages')).toBeInTheDocument();
    });

    expect(screen.getByText('Human:')).toBeInTheDocument();
    expect(screen.getByText('Claude:')).toBeInTheDocument();
    expect(screen.getByText('Please fix the failing test')).toBeInTheDocument();
    expect(screen.getByText('I found the issue and fixed it.')).toBeInTheDocument();
  });

  it('renders error state when session fetch fails', async () => {
    mockGetAgentSession.mockRejectedValue(new Error('File not found'));

    render(
      <ApprovalModal
        task={makeTask({
          execution: { agentSessionId: 'sess-error-test' },
        })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('session-error')).toBeInTheDocument();
    });

    expect(screen.getByTestId('session-error')).toHaveTextContent('Could not load session');
  });

  it('uses agent name in heading, label, reason pre-fill, and session fetch', async () => {
    mockGetAgentSession.mockResolvedValue([
      { role: 'user', content: 'Fix the bug', timestamp: '' },
      { role: 'assistant', content: 'Done.', timestamp: '' },
    ]);

    render(
      <ApprovalModal
        task={makeTask({
          execution: {
            agentSessionId: 'sess-codex-789',
            agentName: 'codex',
            pendingFixError: 'Test failed',
          },
        })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
        initialAction="reject"
      />,
    );

    // Heading uses "Codex Session"
    expect(screen.getByText('Codex Session')).toBeInTheDocument();

    // Assistant label uses "Codex:"
    await waitFor(() => {
      expect(screen.getByTestId('session-messages')).toBeInTheDocument();
    });
    expect(screen.getByText('Codex:')).toBeInTheDocument();

    // Rejection reason pre-fill uses "Codex session:"
    expect(screen.getByRole('textbox')).toHaveValue(
      'Codex session: sess-codex-789\nOriginal error: Test failed',
    );

    // getAgentSession called with agentName
    expect(mockGetAgentSession).toHaveBeenCalledWith('sess-codex-789', 'codex');
  });

  it('falls back to session UUID parsed from pendingFixError when agentSessionId is missing', async () => {
    mockGetAgentSession.mockResolvedValue([
      { role: 'assistant', content: 'Investigating...', timestamp: '' },
    ]);

    render(
      <ApprovalModal
        task={makeTask({
          execution: {
            agentName: 'codex',
            pendingFixError: 'Post-fix PR prep failed (session=019d5193-197f-79a2-8e37-3551f55b67e7)',
          },
        })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
        initialAction="reject"
      />,
    );

    expect(screen.getByText('Codex Session')).toBeInTheDocument();
    expect(screen.getByText('019d5193-197f-79a2-8e37-3551f55b67e7')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue(
      'Codex session: 019d5193-197f-79a2-8e37-3551f55b67e7\nOriginal error: Post-fix PR prep failed (session=019d5193-197f-79a2-8e37-3551f55b67e7)',
    );

    await waitFor(() => {
      expect(screen.getByTestId('session-messages')).toBeInTheDocument();
    });
    expect(mockGetAgentSession).toHaveBeenCalledWith('019d5193-197f-79a2-8e37-3551f55b67e7', 'codex');
  });

  it('does not fetch session when no agentSessionId', () => {
    render(
      <ApprovalModal
        task={makeTask()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(mockGetAgentSession).not.toHaveBeenCalled();
  });

  it('uses lastAgentSessionId when agentSessionId is missing', async () => {
    mockGetAgentSession.mockResolvedValue([
      { role: 'assistant', content: 'Recovered durable session.', timestamp: '' },
    ]);

    render(
      <ApprovalModal
        task={makeTask({
          execution: { lastAgentSessionId: 'sess-last-456', lastAgentName: 'codex' },
        })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(mockGetAgentSession).toHaveBeenCalledWith('sess-last-456', 'codex');
    });
    expect(mockGetEvents).not.toHaveBeenCalled();
  });

  it('falls back to latest agentSessionId from task events when execution has none', async () => {
    mockGetEvents.mockResolvedValue([
      {
        id: 1,
        taskId: 'task-1',
        eventType: 'task.awaiting_approval',
        payload: JSON.stringify({
          status: 'awaiting_approval',
          execution: { agentSessionId: 'sess-from-events-123', agentName: 'codex' },
        }),
        createdAt: '2026-04-03 00:00:00',
      },
    ]);
    mockGetAgentSession.mockResolvedValue([
      { role: 'assistant', content: 'Recovered from event history.', timestamp: '' },
    ]);

    render(
      <ApprovalModal
        task={makeTask({ execution: {} })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
        initialAction="reject"
      />,
    );

    await waitFor(() => {
      expect(mockGetAgentSession).toHaveBeenCalledWith('sess-from-events-123', 'codex');
    });

    expect(screen.getByText('sess-from-events-123')).toBeInTheDocument();
    expect(screen.getByText('Codex Session')).toBeInTheDocument();
  });

  // ── Approve callback ──────────────────────────────────────

  it('calls onApprove with task ID when Approve is clicked', () => {
    const onApprove = vi.fn();
    const onClose = vi.fn();
    render(
      <ApprovalModal
        task={makeTask({ id: 'task-42' })}
        onApprove={onApprove}
        onReject={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByText('Approve'));
    expect(onApprove).toHaveBeenCalledWith('task-42');
    expect(onClose).toHaveBeenCalled();
  });

  // ── Reject callback ───────────────────────────────────────

  it('calls onReject with task ID and reason on confirm reject', () => {
    const onReject = vi.fn();
    const onClose = vi.fn();
    render(
      <ApprovalModal
        task={makeTask({ id: 'task-7' })}
        onApprove={vi.fn()}
        onReject={onReject}
        onClose={onClose}
      />,
    );
    // First click reveals textarea
    fireEvent.click(screen.getByText('Reject'));
    // Type a reason
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Bad output' },
    });
    // Second click confirms
    fireEvent.click(screen.getByText('Confirm Reject'));
    expect(onReject).toHaveBeenCalledWith('task-7', 'Bad output');
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onReject with undefined reason when reason is empty', () => {
    const onReject = vi.fn();
    render(
      <ApprovalModal
        task={makeTask({ id: 'task-8' })}
        onApprove={vi.fn()}
        onReject={onReject}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Reject'));
    fireEvent.click(screen.getByText('Confirm Reject'));
    expect(onReject).toHaveBeenCalledWith('task-8', undefined);
  });

  it('renders "Confirm Merge" heading for merge node with onFinish="merge"', () => {
    render(
      <ApprovalModal
        task={makeTask({ config: { isMergeNode: true } })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
        onFinish="merge"
      />,
    );
    expect(screen.getByRole('heading', { name: 'Confirm Merge' })).toBeInTheDocument();
  });

  it('renders "Confirm Pull Request" heading for merge node with onFinish="pull_request"', () => {
    render(
      <ApprovalModal
        task={makeTask({ config: { isMergeNode: true } })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
        onFinish="pull_request"
      />,
    );
    expect(screen.getByRole('heading', { name: 'Confirm Pull Request' })).toBeInTheDocument();
  });

  it('shows "Confirm Merge" button label for merge node with onFinish="merge"', () => {
    render(
      <ApprovalModal
        task={makeTask({ config: { isMergeNode: true } })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
        onFinish="merge"
      />,
    );
    expect(screen.getByText('Confirm Merge')).toBeInTheDocument();
  });

  it('shows "Confirm Create PR" button label for merge node with onFinish="pull_request"', () => {
    render(
      <ApprovalModal
        task={makeTask({ config: { isMergeNode: true } })}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
        onFinish="pull_request"
      />,
    );
    expect(screen.getByText('Confirm Create PR')).toBeInTheDocument();
  });
});
