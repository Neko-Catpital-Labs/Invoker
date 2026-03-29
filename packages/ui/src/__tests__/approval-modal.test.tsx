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

// Mock window.invoker.getClaudeSession
const mockGetClaudeSession = vi.fn();

beforeEach(() => {
  mockGetClaudeSession.mockReset();
  // Default: resolve with null (no session found)
  mockGetClaudeSession.mockResolvedValue(null);
  (window as any).invoker = {
    getClaudeSession: mockGetClaudeSession,
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

  // ── Fix-with-Claude approval (pendingFixError set) ─────────

  it('renders "Approve AI Fix" heading for fix-with-claude approval', () => {
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

  it('renders both session and fix context blocks for fix approval with session ID', async () => {
    mockGetClaudeSession.mockResolvedValue([
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
    const sessionBlock = screen.getByTestId('claude-session-context');
    expect(sessionBlock).toBeInTheDocument();
    expect(sessionBlock).toHaveTextContent('sess-abc-123');

    const fixBlock = screen.getByTestId('fix-context');
    expect(fixBlock).toBeInTheDocument();
    expect(fixBlock).toHaveTextContent('Test failed: expected 1 but got 2');
  });

  it('renders fix context with only error when no session ID', () => {
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
    expect(screen.queryByTestId('claude-session-context')).not.toBeInTheDocument();
    const fixBlock = screen.getByTestId('fix-context');
    expect(fixBlock).toBeInTheDocument();
    expect(fixBlock).toHaveTextContent('Exit code 1');
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
    mockGetClaudeSession.mockReturnValue(new Promise(() => {}));

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
    mockGetClaudeSession.mockResolvedValue([
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
    mockGetClaudeSession.mockRejectedValue(new Error('File not found'));

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

  it('does not fetch session when no agentSessionId', () => {
    render(
      <ApprovalModal
        task={makeTask()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(mockGetClaudeSession).not.toHaveBeenCalled();
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
