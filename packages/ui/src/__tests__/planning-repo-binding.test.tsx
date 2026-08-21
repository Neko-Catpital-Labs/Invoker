import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

describe('planning composer repo binding', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  async function openComposerOptions() {
    fireEvent.click(await screen.findByTestId('sidebar-home'));
    const expandPlanningChats = screen.queryByRole('button', { name: 'Expand planning chats' });
    if (expandPlanningChats) fireEvent.click(expandPlanningChats);
    if (!screen.queryByTestId('invoker-terminal-harness')) {
      fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
    }
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toBeInTheDocument();
    });
  }

  it('binds a repo typed into an empty chat and shows it in the details panel', async () => {
    render(<App />);
    await openComposerOptions();

    const repoInput = screen.getByTestId('invoker-terminal-repo');
    fireEvent.change(repoInput, { target: { value: '/tmp/repo-a' } });
    fireEvent.keyDown(repoInput, { key: 'Enter' });

    await waitFor(() => {
      expect(mock.api.planningChatCreate).toHaveBeenCalledWith({
        presetKey: 'codex',
        title: 'Untitled plan',
        confirmationMode: 'require',
      });
      expect(mock.api.planningChatRebindRepo).toHaveBeenCalledWith({
        sessionId: 'session-1',
        repoUrl: '/tmp/repo-a',
      });
    });

    fireEvent.click(screen.getByTestId('planning-context-toggle'));
    await waitFor(() => {
      expect(screen.getByTestId('planning-repo-status')).toHaveTextContent('tmp/repo-a');
    });
    expect(screen.queryByTestId('invoker-terminal-repo-error')).not.toBeInTheDocument();
  });

  it('shows the bind error and keeps the previous binding when the rebind is refused', async () => {
    mock.api.planningChatRebindRepo = vi.fn(async () => ({
      ok: false as const,
      error: 'Set the repo before the conversation or terminal starts.',
    }));

    render(<App />);
    await openComposerOptions();

    const repoInput = screen.getByTestId('invoker-terminal-repo');
    fireEvent.change(repoInput, { target: { value: '/tmp/repo-b' } });
    fireEvent.keyDown(repoInput, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-repo-error')).toHaveTextContent(
        'Set the repo before the conversation or terminal starts.',
      );
    });
    fireEvent.click(screen.getByTestId('planning-context-toggle'));
    expect(await screen.findByTestId('planning-repo-status')).toHaveTextContent('No repository bound yet');
    expect(screen.getByTestId('invoker-terminal-repo')).toHaveValue('/tmp/repo-b');
  });

  it('sends exactly once when Send is clicked with uncommitted repo text', async () => {
    let createCalls = 0;
    mock.api.planningChatCreate = vi.fn(async () => {
      createCalls += 1;
      return {
        ok: true as const,
        session: makePlanningSessionSummary({
          id: `created-${createCalls}`,
          title: 'Untitled plan',
          status: 'still_discussing',
          presetKey: 'codex',
          messages: [],
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          draftPlanText: undefined,
        }),
      };
    });
    mock.api.planningChatSend = vi.fn(async (request) => ({
      ok: true as const,
      sessionId: request.sessionId ?? 'server-created',
      reply: 'On it.',
      confirmationMode: 'require' as const,
      draftPlanAvailable: false,
    }));

    render(<App />);
    await openComposerOptions();

    const repoInput = screen.getByTestId('invoker-terminal-repo');
    fireEvent.change(repoInput, { target: { value: '/tmp/repo-a' } });
    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: 'hello planner' } });

    // Clicking the Send button first blurs the repo field, then submits the form.
    fireEvent.blur(repoInput);
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(1);
    });
    expect(mock.api.planningChatCreate).toHaveBeenCalledTimes(1);
    expect(mock.api.planningChatRebindRepo).toHaveBeenCalledTimes(1);
    expect(mock.api.planningChatRebindRepo).toHaveBeenCalledWith({
      sessionId: 'created-1',
      repoUrl: '/tmp/repo-a',
    });
    expect(mock.api.planningChatSend).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'created-1',
      message: 'hello planner',
    }));
    // The message renders in the transcript and again as the sidebar preview.
    expect(screen.getAllByText('hello planner').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('On it.').length).toBeGreaterThanOrEqual(1);
    // The composer must clear, or a second click re-sends the same message.
    expect(screen.getByTestId('invoker-terminal-input')).toHaveValue('');
  });

  it('hides the repo field once the conversation has messages', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true as const,
      sessions: [
        makePlanningSessionSummary({
          id: 'existing-chat',
          title: 'Existing chat',
          status: 'still_discussing',
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          draftPlanText: undefined,
        }),
      ],
    }));

    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-home'));
    const rail = await screen.findByTestId('planning-session-list');
    await waitFor(() => {
      expect(within(rail).getByText('Existing chat')).toBeInTheDocument();
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('invoker-terminal-repo')).not.toBeInTheDocument();
  });
});
