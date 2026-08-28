import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { WorkerStatusSnapshot } from '../types.js';
import { VillageView } from '../components/VillageView.js';
import { LeftStatusColumn } from '../components/LeftStatusColumn.js';

vi.mock('../../../botvillage/static/village.js?url', () => ({
  default: '/mock-village.js',
}));

describe('VillageView', () => {
  beforeEach(() => {
    window.Botvillage = {
      mount: vi.fn(() => ({
        setWorld: vi.fn(),
        select: vi.fn(),
        destroy: vi.fn(),
      })),
    };
  });

  it('renders the village surface without the workers rail', () => {
    const snapshot: WorkerStatusSnapshot = {
      generatedAt: '2026-08-27T12:00:00.000Z',
      workers: [{
        kind: 'reaper',
        note: 'Reaper',
        lifecycle: 'running',
        policy: 'enabled',
        autoStarts: true,
        startable: true,
        stoppable: true,
        recentActions: [],
      }],
    };
    render(<VillageView snapshot={snapshot} remoteTargets={['mac-mini']} />);
    expect(screen.getByTestId('village-surface')).toBeTruthy();
    expect(screen.queryByTestId('workers-rail')).toBeNull();
    expect(screen.getByText('Village')).toBeTruthy();
  });
});

describe('LeftStatusColumn village item', () => {
  it('exposes a Village sidebar control next to Workers', () => {
    render(
      <LeftStatusColumn
        workflowCount={1}
        runningWorkflowCount={0}
        attentionCount={0}
        workerStatus={{ generatedAt: 't', workers: [] }}
        selectedSurface="workers"
        collapsed={false}
        onSelectSurface={() => {}}
        onToggleCollapsed={() => {}}
        planningSessionCount={0}
        planningAttentionCount={0}
        onOpenSettings={() => {}}
        theme="dark"
        onToggleTheme={() => {}}
      />,
    );
    expect(screen.getByTestId('sidebar-workers')).toBeTruthy();
    expect(screen.getByTestId('sidebar-village')).toBeTruthy();
    expect(screen.getByLabelText('Village')).toBeTruthy();
  });
});
