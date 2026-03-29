import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { MergeGateNode } from '../components/MergeGateNode.js';

function renderNode(data: Record<string, unknown>) {
  return render(
    <ReactFlowProvider>
      <MergeGateNode data={data as any} />
    </ReactFlowProvider>,
  );
}

describe('MergeGateNode', () => {
  it('displays baseBranch when provided', () => {
    renderNode({ status: 'pending', label: 'Plan', gateKind: 'merge', baseBranch: 'master' });
    expect(screen.getByTestId('merge-branch-label')).toHaveTextContent('master');
  });

  it('displays "default" when baseBranch is undefined', () => {
    renderNode({ status: 'pending', label: 'Plan', gateKind: 'merge' });
    expect(screen.getByTestId('merge-branch-label')).toHaveTextContent('default');
  });

  it('branch label is read-only (no input rendered)', () => {
    renderNode({ status: 'pending', label: 'Plan', gateKind: 'merge', baseBranch: 'master' });
    expect(screen.queryByTestId('merge-branch-input')).not.toBeInTheDocument();
  });

  it('shows pull request primary label when gateKind is pull_request', () => {
    renderNode({ status: 'completed', label: 'My plan', gateKind: 'pull_request', baseBranch: 'master' });
    expect(screen.getByTestId('merge-gate-primary-label')).toHaveTextContent('Pull request');
  });

  it('shows merge primary label when gateKind is merge', () => {
    renderNode({ status: 'completed', label: 'My plan', gateKind: 'merge', baseBranch: 'master' });
    expect(screen.getByTestId('merge-gate-primary-label')).toHaveTextContent('Merge');
  });

  it('shows Review primary label when gateKind is external_review', () => {
    renderNode({
      status: 'pending',
      label: 'My plan',
      gateKind: 'external_review',
      showMergeModeRow: false,
      baseBranch: 'master',
      mergeMode: 'external_review',
    });
    expect(screen.getByTestId('merge-gate-primary-label')).toHaveTextContent('Review');
  });

  it('hides duplicate merge mode row for external_review', () => {
    renderNode({
      status: 'pending',
      label: 'My plan',
      gateKind: 'external_review',
      showMergeModeRow: false,
      baseBranch: 'master',
      mergeMode: 'external_review',
    });
    expect(screen.queryByTestId('merge-mode-display')).not.toBeInTheDocument();
  });

  it('always renders the branch display area', () => {
    renderNode({ status: 'pending', label: 'Plan', gateKind: 'merge' });
    expect(screen.getByTestId('merge-branch-display')).toBeInTheDocument();
  });

  it('displays manual merge mode by default', () => {
    renderNode({ status: 'pending', label: 'Plan', gateKind: 'merge', baseBranch: 'master' });
    expect(screen.getByTestId('merge-mode-label')).toHaveTextContent('Manual');
  });

  it('displays automatic merge mode when specified', () => {
    renderNode({ status: 'pending', label: 'Plan', gateKind: 'merge', baseBranch: 'master', mergeMode: 'automatic' });
    expect(screen.getByTestId('merge-mode-label')).toHaveTextContent('Automatic');
  });

  it('displays manual merge mode when explicitly specified', () => {
    renderNode({ status: 'pending', label: 'Plan', gateKind: 'merge', baseBranch: 'master', mergeMode: 'manual' });
    expect(screen.getByTestId('merge-mode-label')).toHaveTextContent('Manual');
  });

  it('shows approve button for manual merge gate with awaiting_approval status', () => {
    renderNode({
      status: 'awaiting_approval',
      label: 'Plan',
      gateKind: 'merge',
      baseBranch: 'master',
      mergeMode: 'manual',
      workflowId: 'wf-123',
    });
    expect(screen.getByTestId('approve-merge-button')).toBeInTheDocument();
    expect(screen.getByTestId('approve-merge-button')).toHaveTextContent('Approve & Merge');
  });

  it('shows "Approve & Create PR" for pull_request gate kind', () => {
    renderNode({
      status: 'awaiting_approval',
      label: 'Plan',
      gateKind: 'pull_request',
      baseBranch: 'master',
      mergeMode: 'manual',
      workflowId: 'wf-123',
    });
    expect(screen.getByTestId('approve-merge-button')).toBeInTheDocument();
    expect(screen.getByTestId('approve-merge-button')).toHaveTextContent('Approve & Create PR');
  });

  it('shows "Approve Fix" when pendingFixError is set (overrides gate kind label)', () => {
    renderNode({
      status: 'awaiting_approval',
      label: 'Plan',
      gateKind: 'pull_request',
      baseBranch: 'master',
      mergeMode: 'manual',
      workflowId: 'wf-123',
      pendingFixError: 'merge conflict',
    });
    expect(screen.getByTestId('approve-merge-button')).toHaveTextContent('Approve Fix');
  });

  it('shows "Approve" for workflow gate kind', () => {
    renderNode({
      status: 'awaiting_approval',
      label: 'Plan',
      gateKind: 'workflow',
      baseBranch: 'master',
      mergeMode: 'manual',
      workflowId: 'wf-123',
    });
    expect(screen.getByTestId('approve-merge-button')).toBeInTheDocument();
    expect(screen.getByTestId('approve-merge-button')).toHaveTextContent('Approve');
  });

  it('does not show approve button for manual merge gate with completed status', () => {
    renderNode({
      status: 'completed',
      label: 'Plan',
      gateKind: 'merge',
      baseBranch: 'master',
      mergeMode: 'manual',
      workflowId: 'wf-123',
    });
    expect(screen.queryByTestId('approve-merge-button')).not.toBeInTheDocument();
  });

  it('does not show approve button for automatic merge gate with completed status', () => {
    renderNode({
      status: 'completed',
      label: 'Plan',
      gateKind: 'merge',
      baseBranch: 'master',
      mergeMode: 'automatic',
      workflowId: 'wf-123',
    });
    expect(screen.queryByTestId('approve-merge-button')).not.toBeInTheDocument();
  });

  it('does not show approve button for manual merge gate with pending status', () => {
    renderNode({
      status: 'pending',
      label: 'Plan',
      gateKind: 'merge',
      baseBranch: 'master',
      mergeMode: 'manual',
      workflowId: 'wf-123',
    });
    expect(screen.queryByTestId('approve-merge-button')).not.toBeInTheDocument();
  });

  it('does not show approve button for manual merge gate with failed status', () => {
    renderNode({
      status: 'failed',
      label: 'Plan',
      gateKind: 'merge',
      baseBranch: 'master',
      mergeMode: 'manual',
      workflowId: 'wf-123',
    });
    expect(screen.queryByTestId('approve-merge-button')).not.toBeInTheDocument();
  });

  it('forces Review primary and hides mode row when mergeMode is external_review (even if gateKind was merge)', () => {
    renderNode({ status: 'pending', label: 'Plan', gateKind: 'merge', baseBranch: 'master', mergeMode: 'external_review' });
    expect(screen.getByTestId('merge-gate-primary-label')).toHaveTextContent('Review');
    expect(screen.queryByTestId('merge-mode-display')).not.toBeInTheDocument();
  });

  it('hides mode row when mergeMode is external_review even if gateKind is pull_request', () => {
    renderNode({
      status: 'pending',
      label: 'Plan',
      gateKind: 'pull_request',
      baseBranch: 'master',
      mergeMode: 'external_review',
    });
    expect(screen.getByTestId('merge-gate-primary-label')).toHaveTextContent('Review');
    expect(screen.queryByTestId('merge-mode-display')).not.toBeInTheDocument();
  });

  it('does NOT show approve button in external_review mode even when awaiting_approval', () => {
    renderNode({
      status: 'awaiting_approval',
      label: 'Plan',
      gateKind: 'external_review',
      showMergeModeRow: false,
      baseBranch: 'master',
      mergeMode: 'external_review',
      workflowId: 'wf-123',
    });
    expect(screen.queryByTestId('approve-merge-button')).not.toBeInTheDocument();
  });

  it('updates merge mode display when re-rendered with new mergeMode', () => {
    const baseData = { status: 'pending', label: 'Plan', gateKind: 'merge' as const, baseBranch: 'master' };

    const { rerender } = renderNode({ ...baseData, mergeMode: 'manual' });
    expect(screen.getByTestId('merge-mode-label')).toHaveTextContent('Manual');

    rerender(
      <ReactFlowProvider>
        <MergeGateNode data={{ ...baseData, mergeMode: 'external_review' } as any} />
      </ReactFlowProvider>,
    );
    expect(screen.getByTestId('merge-gate-primary-label')).toHaveTextContent('Review');
    expect(screen.queryByTestId('merge-mode-display')).not.toBeInTheDocument();

    rerender(
      <ReactFlowProvider>
        <MergeGateNode data={{ ...baseData, mergeMode: 'automatic' } as any} />
      </ReactFlowProvider>,
    );
    expect(screen.getByTestId('merge-mode-label')).toHaveTextContent('Automatic');
  });

  it('each merge mode has a distinct color class on the label', () => {
    const baseData = { status: 'pending', label: 'Plan', gateKind: 'merge' as const, baseBranch: 'master' };

    const { rerender } = renderNode({ ...baseData, mergeMode: 'manual' });
    expect(screen.getByTestId('merge-mode-label')).toHaveClass('text-yellow-500');

    rerender(
      <ReactFlowProvider>
        <MergeGateNode data={{ ...baseData, mergeMode: 'external_review' } as any} />
      </ReactFlowProvider>,
    );
    expect(screen.getByTestId('merge-gate-primary-label')).toHaveTextContent('Review');

    rerender(
      <ReactFlowProvider>
        <MergeGateNode data={{ ...baseData, mergeMode: 'automatic' } as any} />
      </ReactFlowProvider>,
    );
    expect(screen.getByTestId('merge-mode-label')).toHaveClass('text-green-500');
  });

  it('shows summary preview when summary is provided', () => {
    renderNode({
      status: 'awaiting_approval',
      label: 'Plan',
      gateKind: 'pull_request',
      baseBranch: 'master',
      summary: 'Short summary text',
    });
    const preview = screen.getByTestId('merge-summary-preview');
    expect(preview).toBeInTheDocument();
    expect(preview).toHaveTextContent('Short summary text');
  });

  it('does not show summary preview when summary is absent', () => {
    renderNode({
      status: 'awaiting_approval',
      label: 'Plan',
      gateKind: 'pull_request',
      baseBranch: 'master',
    });
    expect(screen.queryByTestId('merge-summary-preview')).not.toBeInTheDocument();
  });

  it('truncates long summary with ellipsis', () => {
    const longSummary = 'A'.repeat(200);
    renderNode({
      status: 'awaiting_approval',
      label: 'Plan',
      gateKind: 'pull_request',
      baseBranch: 'master',
      summary: longSummary,
    });
    const preview = screen.getByTestId('merge-summary-preview');
    expect(preview.textContent).toBe('A'.repeat(120) + '...');
    expect(preview).toHaveAttribute('title', longSummary);
  });
});
