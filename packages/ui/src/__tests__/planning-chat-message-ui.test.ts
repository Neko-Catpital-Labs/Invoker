import { describe, expect, it } from 'vitest';
import {
  collapsePlanningChatLines,
  extractPlanningChatCopyCommand,
  groupPlanningChatLines,
  humanizePlanningChatErrorTitle,
  presentPlanningChatError,
  splitPlanningChatInlineCode,
} from '../lib/planning-chat-message-ui.js';

describe('planning-chat-message-ui', () => {
  it('humanizes auth failures into a short signed-in title', () => {
    expect(humanizePlanningChatErrorTitle(
      "Cursor isn't authenticated. Run `cursor agent login` or set CURSOR_API_KEY, then try again.",
    )).toBe("Cursor isn't signed in");
    expect(humanizePlanningChatErrorTitle(
      'codex: Authentication required. Run `codex login`, then try again.',
    )).toBe("codex isn't signed in");
  });

  it('presents auth errors with recovery body and copyable command', () => {
    const presented = presentPlanningChatError(
      "Cursor isn't authenticated. Run `cursor agent login` or set CURSOR_API_KEY, then try again.",
    );
    expect(presented.title).toBe("Cursor isn't signed in");
    expect(presented.body).toContain('cursor agent login');
    expect(presented.copyCommand).toBe('cursor agent login');
  });

  it('splits inline code chips for recovery hints', () => {
    expect(splitPlanningChatInlineCode('Run `cursor agent login` or set CURSOR_API_KEY.')).toEqual([
      { kind: 'text', text: 'Run ' },
      { kind: 'code', text: 'cursor agent login' },
      { kind: 'text', text: ' or set CURSOR_API_KEY.' },
    ]);
    expect(extractPlanningChatCopyCommand('Run `codex login` now.')).toBe('codex login');
  });

  it('collapses consecutive identical system errors and groups by sender', () => {
    const collapsed = collapsePlanningChatLines([
      { id: 1, text: 'hello', role: 'user' as const },
      { id: 2, text: 'err', role: 'system' as const, tone: 'error' as const },
      { id: 3, text: 'err', role: 'system' as const, tone: 'error' as const },
      { id: 4, text: 'other', role: 'system' as const, tone: 'error' as const },
      { id: 5, text: 'note', role: 'system' as const },
    ]);
    expect(collapsed).toEqual([
      { id: 1, text: 'hello', role: 'user', tone: undefined, count: 1, kind: 'user' },
      { id: 2, text: 'err', role: 'system', tone: 'error', count: 2, kind: 'system-error' },
      { id: 4, text: 'other', role: 'system', tone: 'error', count: 1, kind: 'system-error' },
      { id: 5, text: 'note', role: 'system', tone: undefined, count: 1, kind: 'system-notice' },
    ]);
    expect(groupPlanningChatLines(collapsed).map((group) => group.kind)).toEqual([
      'user',
      'system-error',
      'system-notice',
    ]);
  });
});
