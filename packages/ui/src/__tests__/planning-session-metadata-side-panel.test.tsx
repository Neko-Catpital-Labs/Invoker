import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker, type MockPlanningSessionMetadataResponse } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function persistedPlanningSession() {
  return {
    ...makePlanningSessionSummary({
      id: 'summary-planning-session',
      title: 'Summary planning chat',
      status: 'still_discussing',
      draftPlanAvailable: false,
      draftPlanSummary: undefined,
      draftPlanText: undefined,
    }),
    agentSessionId: 'summary-agent-session-ignored',
    rawSessionFilePath: '/summary/path/ignored.jsonl',
  };
}

describe('planning session metadata side panel', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('renders loading and copy-friendly metadata returned by IPC for the active persisted planning session', async () => {
    const metadata = deferred<MockPlanningSessionMetadataResponse>();
    const metadataQuery = vi.fn(() => metadata.promise);
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [persistedPlanningSession()],
    })) as any;
    mock.api.planningSessionMetadata = metadataQuery;

    render(<App />);

    await waitFor(() => {
      expect(metadataQuery).toHaveBeenCalledWith({ sessionId: 'summary-planning-session' });
    });

    fireEvent.click(await screen.findByTestId('planning-context-toggle'));
    expect(screen.getByTestId('planning-session-metadata-loading')).toHaveTextContent('Loading session metadata');

    await act(async () => {
      metadata.resolve({
        ok: true,
        metadata: {
          planningSessionId: 'ipc-planning-session',
          agentName: 'Codex',
          agentSessionId: 'codex-session-from-ipc',
          rawSessionFilePath: '/home/user/.codex/sessions/2026/07/29/ipc-session.jsonl',
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('planning-metadata-planning-session-id')).toHaveTextContent('ipc-planning-session');
    });
    expect(screen.getByTestId('planning-metadata-agent-session-id')).toHaveTextContent('codex-session-from-ipc');
    expect(screen.getByTestId('planning-metadata-raw-session-file-location')).toHaveTextContent('/home/user/.codex/sessions/2026/07/29/ipc-session.jsonl');
    expect(screen.getByText('Codex session ID')).toBeInTheDocument();
    expect(screen.queryByText('summary-agent-session-ignored')).not.toBeInTheDocument();
    expect(screen.queryByText('/summary/path/ignored.jsonl')).not.toBeInTheDocument();
  });

  it('shows unavailable metadata without deriving values from the planning summary', async () => {
    const metadataQuery = vi.fn(async () => ({
      ok: false,
      unavailableReason: 'No agent session metadata has been captured.',
    }));
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [persistedPlanningSession()],
    })) as any;
    mock.api.planningSessionMetadata = metadataQuery;

    render(<App />);

    await waitFor(() => {
      expect(metadataQuery).toHaveBeenCalledWith({ sessionId: 'summary-planning-session' });
    });

    fireEvent.click(await screen.findByTestId('planning-context-toggle'));

    expect(await screen.findByTestId('planning-session-metadata-unavailable')).toHaveTextContent('No agent session metadata has been captured.');
    expect(screen.queryByText('summary-agent-session-ignored')).not.toBeInTheDocument();
    expect(screen.queryByText('/summary/path/ignored.jsonl')).not.toBeInTheDocument();
  });
});
