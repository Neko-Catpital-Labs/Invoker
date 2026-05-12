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
  it('renders merge gate with dashed card shell and primary label', () => {
    const { container } = renderNode({ status: 'pending', label: 'Plan', gateKind: 'merge' });
    expect(screen.getByTestId('merge-gate-primary-label')).toHaveTextContent('Merge');
    expect(container.firstChild).toHaveClass('border-dashed');
  });

  it('shows pull request primary label when gateKind is pull_request', () => {
    renderNode({ status: 'completed', label: 'My plan', gateKind: 'pull_request' });
    expect(screen.getByTestId('merge-gate-primary-label')).toHaveTextContent('Pull request');
  });

  it('shows Review primary label when mergeMode is external_review', () => {
    renderNode({ status: 'pending', label: 'My plan', gateKind: 'merge', mergeMode: 'external_review' });
    expect(screen.getByTestId('merge-gate-primary-label')).toHaveTextContent('Review');
  });

  it('does not render branch, merge mode, or summary rows in DAG node', () => {
    renderNode({
      status: 'awaiting_approval',
      label: 'Plan',
      gateKind: 'pull_request',
      mergeMode: 'manual',
      summary: 'summary text',
      baseBranch: 'master',
      featureBranch: 'feature/x',
    });

    expect(screen.queryByTestId('merge-branch-display')).not.toBeInTheDocument();
    expect(screen.queryByTestId('merge-branch-label')).not.toBeInTheDocument();
    expect(screen.queryByTestId('merge-mode-display')).not.toBeInTheDocument();
    expect(screen.queryByTestId('merge-summary-preview')).not.toBeInTheDocument();
  });

  it('does not render an inline approve button for manual merge gate with awaiting_approval status', () => {
    renderNode({
      status: 'awaiting_approval',
      label: 'Plan',
      gateKind: 'merge',
      mergeMode: 'manual',
      workflowId: 'wf-123',
    });
    expect(screen.queryByTestId('approve-merge-button')).not.toBeInTheDocument();
  });

  it('does not render an inline approve button for manual pull_request gate with review_ready status', () => {
    renderNode({
      status: 'review_ready',
      label: 'Plan',
      gateKind: 'pull_request',
      mergeMode: 'manual',
      workflowId: 'wf-123',
    });
    expect(screen.queryByTestId('approve-merge-button')).not.toBeInTheDocument();
  });

  it('does not render an inline approve button when pendingFixError is set', () => {
    renderNode({
      status: 'awaiting_approval',
      label: 'Plan',
      gateKind: 'pull_request',
      mergeMode: 'manual',
      workflowId: 'wf-123',
      pendingFixError: 'merge conflict',
    });
    expect(screen.queryByTestId('approve-merge-button')).not.toBeInTheDocument();
  });

  it('does not render an inline approve button in external_review mode', () => {
    renderNode({
      status: 'awaiting_approval',
      label: 'Plan',
      gateKind: 'external_review',
      mergeMode: 'external_review',
      workflowId: 'wf-123',
    });
    expect(screen.queryByTestId('approve-merge-button')).not.toBeInTheDocument();
  });
});
