import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CommandPalette } from '../components/CommandPalette.js';
import type { TaskState, WorkflowMeta } from '../types.js';

function buildFixtures() {
  const workflows = new Map<string, WorkflowMeta>([
    ['wf-alpha', { id: 'wf-alpha', name: 'Alpha workflow', status: 'running' }],
    ['wf-beta', { id: 'wf-beta', name: 'Beta workflow', status: 'failed' }],
  ]);
  const tasks = new Map<string, TaskState>([
    ['t-1', {
      id: 't-1',
      description: 'Fix broken flag propagation',
      status: 'failed',
      config: { workflowId: 'wf-beta' } as unknown as TaskState['config'],
    } as TaskState],
    ['t-2', {
      id: 't-2',
      description: 'Run integration suite',
      status: 'running',
      config: { workflowId: 'wf-alpha' } as unknown as TaskState['config'],
    } as TaskState],
  ]);
  return { workflows, tasks };
}

describe('CommandPalette', () => {
  it('renders navigate section headings when open', () => {
    const { workflows, tasks } = buildFixtures();
    render(
      <CommandPalette
        open
        onOpenChange={() => {}}
        workflows={workflows}
        tasks={tasks}
        onSelectSurface={() => {}}
        onSelectWorkflow={() => {}}
        onSelectTask={() => {}}
        onOpenSettings={() => {}}
        planningSessionCount={0}
      />,
    );
    expect(screen.getByText(/Navigate/i)).toBeInTheDocument();
    expect(screen.getByText(/Go home/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Needs Attention/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Workflows/i).length).toBeGreaterThan(0);
  });

  it('lists workflows and calls onSelectWorkflow on click', async () => {
    const { workflows, tasks } = buildFixtures();
    const onSelectWorkflow = vi.fn();
    render(
      <CommandPalette
        open
        onOpenChange={() => {}}
        workflows={workflows}
        tasks={tasks}
        onSelectSurface={() => {}}
        onSelectWorkflow={onSelectWorkflow}
        onSelectTask={() => {}}
        onOpenSettings={() => {}}
        planningSessionCount={0}
      />,
    );

    const betaItem = await screen.findByText('Beta workflow');
    fireEvent.click(betaItem);
    await waitFor(() => expect(onSelectWorkflow).toHaveBeenCalledWith('wf-beta'));
  });

  it('shows failed task under the needs-attention group', async () => {
    const { workflows, tasks } = buildFixtures();
    render(
      <CommandPalette
        open
        onOpenChange={() => {}}
        workflows={workflows}
        tasks={tasks}
        onSelectSurface={() => {}}
        onSelectWorkflow={() => {}}
        onSelectTask={() => {}}
        onOpenSettings={() => {}}
        planningSessionCount={2}
      />,
    );
    expect(await screen.findByText('Fix broken flag propagation')).toBeInTheDocument();
    expect(screen.getAllByText('2').length).toBeGreaterThan(0);
  });
});
