import { describe, expect, it, vi } from 'vitest';
import {
  createInAppPlanningChatSessions,
  deletePlanningChat,
  deleteSubmittedPlanningChats,
} from '../in-app-planner.js';

describe('planning chat deletion', () => {
  it('closes the terminal and deletes memory, store, and override conversation', () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('plan-1', {
      id: 'plan-1',
      status: 'draft_ready',
      terminalSessionId: 'term-1',
    });
    const calls: string[] = [];

    const result = deletePlanningChat({ sessionId: 'plan-1' }, {
      sessions,
      closeTerminal: (id) => calls.push(`close:${id}`),
      planningSessionStore: {
        deleteInAppPlanningSession: (id) => calls.push(`store:${id}`),
      },
      conversationRepo: {
        deleteConversation: (id) => calls.push(`conversation:${id}`),
      },
    });

    expect(result).toEqual({ ok: true });
    expect(sessions.has('plan-1')).toBe(false);
    expect(calls).toEqual([
      'close:term-1',
      'store:plan-1',
      'conversation:plan-1',
    ]);
  });

  it('best-effort deletes persisted rows for an unknown session', () => {
    const sessions = createInAppPlanningChatSessions();
    const calls: string[] = [];

    const result = deletePlanningChat({ sessionId: 'missing' }, {
      sessions,
      closeTerminal: (id) => calls.push(`close:${id}`),
      planningSessionStore: {
        deleteInAppPlanningSession: (id) => calls.push(`store:${id}`),
      },
      conversationRepo: {
        deleteConversation: (id) => calls.push(`conversation:${id}`),
      },
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(['store:missing', 'conversation:missing']);
  });

  it('deletes only submitted sessions in bulk from a snapshot', () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('draft', { id: 'draft', status: 'draft_ready', terminalSessionId: 'term-draft' });
    sessions.set('submitted-1', { id: 'submitted-1', status: 'submitted', terminalSessionId: 'term-1' });
    sessions.set('submitted-2', { id: 'submitted-2', status: 'submitted' });
    const calls: string[] = [];

    const result = deleteSubmittedPlanningChats({
      sessions,
      closeTerminal: (id) => calls.push(`close:${id}`),
      planningSessionStore: {
        deleteInAppPlanningSession: (id) => calls.push(`store:${id}`),
      },
      conversationRepo: {
        deleteConversation: (id) => calls.push(`conversation:${id}`),
      },
    });

    expect(result).toEqual({ ok: true, deletedSessionIds: ['submitted-1', 'submitted-2'] });
    expect([...sessions.keys()]).toEqual(['draft']);
    expect(calls).toEqual([
      'close:term-1',
      'store:submitted-1',
      'conversation:submitted-1',
      'store:submitted-2',
      'conversation:submitted-2',
    ]);
  });

  it('logs cleanup errors and continues remaining steps', () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('plan-1', {
      id: 'plan-1',
      status: 'submitted',
      terminalSessionId: 'term-1',
    });
    const logger = { error: vi.fn() };
    const calls: string[] = [];

    const result = deletePlanningChat({ sessionId: 'plan-1' }, {
      sessions,
      closeTerminal: () => {
        throw new Error('tmux failed');
      },
      planningSessionStore: {
        deleteInAppPlanningSession: (id) => calls.push(`store:${id}`),
      },
      conversationRepo: {
        deleteConversation: (id) => calls.push(`conversation:${id}`),
      },
      logger,
    });

    expect(result).toEqual({ ok: true });
    expect(sessions.has('plan-1')).toBe(false);
    expect(calls).toEqual(['store:plan-1', 'conversation:plan-1']);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('delete planning chat failed session="plan-1" step="close-terminal": tmux failed'),
      { module: 'planning-chat' },
    );
  });
});
