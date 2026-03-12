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
});
