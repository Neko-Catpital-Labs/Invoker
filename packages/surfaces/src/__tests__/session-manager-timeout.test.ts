import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionManager, SessionIdentifier } from '../slack/thread-session-manager.js';

// ── Mock child_process.spawn ────────────────────────────────

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: () => {
      const { EventEmitter } = require('node:events');
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => {};
      setTimeout(() => {
        proc.stdout.emit('data', Buffer.from('mock response'));
        proc.emit('close', 0);
      }, 0);
      return proc;
    },
  };
});

// ── Mock PlanConversation ────────────────────────────────

let mockPlanConversationCalls: any[] = [];

vi.mock('../slack/plan-conversation.js', () => {
  return {
    PlanConversation: class {
      constructor(config: any) {
        mockPlanConversationCalls.push(config);
      }
      sendMessage = async () => 'mock';
      submittedPlan = null;
      planSubmitted = false;
      init = async () => {};
      reset = () => {};
    },
  };
});

// ── Mock ConversationRepository ─────────────────────────────

function createMockRepo() {
  return {
    saveConversation: vi.fn(),
    loadConversation: vi.fn().mockReturnValue(null),
    deleteConversation: vi.fn(),
    listActiveConversations: vi.fn().mockReturnValue([]),
    cleanupOldConversations: vi.fn().mockReturnValue(0),
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('SessionManager timeoutMs threading', () => {
  let manager: SessionManager;

  afterEach(() => {
    manager?.stop();
    mockPlanConversationCalls = [];
  });

  it('passes timeoutMs to PlanConversation constructor', async () => {
    manager = new SessionManager({
      cursorCommand: 'cursor',
      workingDir: '/fake',
      conversationRepo: createMockRepo() as any,
      evictionIntervalMs: 60_000,
      timeoutMs: 600_000,
    });
    manager.start();

    const id = new SessionIdentifier('C123', '9999.0001');
    await manager.getOrCreateSession(id, 'U001');

    expect(mockPlanConversationCalls.length).toBeGreaterThan(0);
    const lastCall = mockPlanConversationCalls[mockPlanConversationCalls.length - 1];
    expect(lastCall.timeoutMs).toBe(600_000);
  });

  it('does not pass timeoutMs when not configured', async () => {
    manager = new SessionManager({
      cursorCommand: 'cursor',
      workingDir: '/fake',
      conversationRepo: createMockRepo() as any,
      evictionIntervalMs: 60_000,
    });
    manager.start();

    const id = new SessionIdentifier('C456', '8888.0001');
    await manager.getOrCreateSession(id, 'U001');

    expect(mockPlanConversationCalls.length).toBeGreaterThan(0);
    const lastCall = mockPlanConversationCalls[mockPlanConversationCalls.length - 1];
    expect(lastCall.timeoutMs).toBeUndefined();
  });
});
