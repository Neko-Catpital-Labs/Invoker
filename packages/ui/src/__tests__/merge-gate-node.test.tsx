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
    renderNode({ status: 'pending', label: 'All tasks must pass', onFinish: 'merge', baseBranch: 'master' });
    expect(screen.getByTestId('merge-branch-label')).toHaveTextContent('master');
  });

  it('displays "default" when baseBranch is undefined', () => {
    renderNode({ status: 'pending', label: 'All tasks must pass', onFinish: 'merge' });
    expect(screen.getByTestId('merge-branch-label')).toHaveTextContent('default');
  });

  it('branch label is read-only (no input rendered)', () => {
    renderNode({ status: 'pending', label: 'All tasks must pass', onFinish: 'merge', baseBranch: 'master' });
    expect(screen.queryByTestId('merge-branch-input')).not.toBeInTheDocument();
  });

  it('shows pull request icon and label when onFinish is pull_request', () => {
    renderNode({ status: 'completed', label: 'All tasks must pass', onFinish: 'pull_request', baseBranch: 'master' });
    expect(screen.getByText('Pull Request')).toBeInTheDocument();
  });

  it('shows merge icon and label when onFinish is merge', () => {
    renderNode({ status: 'completed', label: 'All tasks must pass', onFinish: 'merge', baseBranch: 'master' });
    expect(screen.getByText('Merge')).toBeInTheDocument();
  });

  it('always renders the branch display area', () => {
    renderNode({ status: 'pending', label: 'All tasks must pass', onFinish: 'merge' });
    expect(screen.getByTestId('merge-branch-display')).toBeInTheDocument();
  });

  it('displays manual merge mode by default', () => {
    renderNode({ status: 'pending', label: 'All tasks must pass', onFinish: 'merge', baseBranch: 'master' });
    expect(screen.getByTestId('merge-mode-label')).toHaveTextContent('Manual');
  });

  it('displays automatic merge mode when specified', () => {
    renderNode({ status: 'pending', label: 'All tasks must pass', onFinish: 'merge', baseBranch: 'master', mergeMode: 'automatic' });
    expect(screen.getByTestId('merge-mode-label')).toHaveTextContent('Automatic');
  });

  it('displays manual merge mode when explicitly specified', () => {
    renderNode({ status: 'pending', label: 'All tasks must pass', onFinish: 'merge', baseBranch: 'master', mergeMode: 'manual' });
    expect(screen.getByTestId('merge-mode-label')).toHaveTextContent('Manual');
  });

  it('shows approve button for manual merge gate with awaiting_approval status', () => {
    renderNode({ status: 'awaiting_approval', label: 'All tasks must pass', onFinish: 'merge', baseBranch: 'master', mergeMode: 'manual', workflowId: 'wf-123' });
    expect(screen.getByTestId('approve-merge-button')).toBeInTheDocument();
    expect(screen.getByTestId('approve-merge-button')).toHaveTextContent('Approve Merge');
  });

  it('does not show approve button for manual merge gate with completed status', () => {
    renderNode({ status: 'completed', label: 'All tasks must pass', onFinish: 'merge', baseBranch: 'master', mergeMode: 'manual', workflowId: 'wf-123' });
    expect(screen.queryByTestId('approve-merge-button')).not.toBeInTheDocument();
  });

  it('does not show approve button for automatic merge gate with completed status', () => {
    renderNode({ status: 'completed', label: 'All tasks must pass', onFinish: 'merge', baseBranch: 'master', mergeMode: 'automatic', workflowId: 'wf-123' });
    expect(screen.queryByTestId('approve-merge-button')).not.toBeInTheDocument();
  });

  it('does not show approve button for manual merge gate with pending status', () => {
    renderNode({ status: 'pending', label: 'All tasks must pass', onFinish: 'merge', baseBranch: 'master', mergeMode: 'manual', workflowId: 'wf-123' });
    expect(screen.queryByTestId('approve-merge-button')).not.toBeInTheDocument();
  });

  it('does not show approve button for manual merge gate with failed status', () => {
    renderNode({ status: 'failed', label: 'All tasks must pass', onFinish: 'merge', baseBranch: 'master', mergeMode: 'manual', workflowId: 'wf-123' });
    expect(screen.queryByTestId('approve-merge-button')).not.toBeInTheDocument();
  });

  it('displays GitHub PR merge mode when specified', () => {
    renderNode({ status: 'pending', label: 'All tasks must pass', onFinish: 'merge', baseBranch: 'master', mergeMode: 'github' });
    expect(screen.getByTestId('merge-mode-label')).toHaveTextContent('GitHub PR');
  });

  it('shows PR link when prUrl is provided in github mode', () => {
    renderNode({
      status: 'awaiting_approval', label: 'All tasks must pass', onFinish: 'merge',
      baseBranch: 'master', mergeMode: 'github', prUrl: 'https://github.com/owner/repo/pull/42',
    });
    expect(screen.getByTestId('pr-link-display')).toBeInTheDocument();
  });

  it('shows PR status when prStatus is provided in github mode', () => {
    renderNode({
      status: 'awaiting_approval', label: 'All tasks must pass', onFinish: 'merge',
      baseBranch: 'master', mergeMode: 'github', prStatus: 'Awaiting review',
    });
    expect(screen.getByTestId('pr-status-display')).toHaveTextContent('Awaiting review');
  });

  it('does NOT show approve button in github mode even when awaiting_approval', () => {
    renderNode({
      status: 'awaiting_approval', label: 'All tasks must pass', onFinish: 'merge',
      baseBranch: 'master', mergeMode: 'github', workflowId: 'wf-123',
    });
    expect(screen.queryByTestId('approve-merge-button')).not.toBeInTheDocument();
  });
});
