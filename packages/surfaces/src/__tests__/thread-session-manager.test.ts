import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionManager, SessionIdentifier, SessionHandle } from '../slack/thread-session-manager.js';

// ── Mock child_process.spawn ────────────────────────────────

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const { EventEmitter } = require('node:events');
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn();
      setTimeout(() => {
        proc.stdout.emit('data', Buffer.from('mock response'));
        proc.emit('close', 0);
      }, 0);
      return proc;
    }),
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

describe('SessionIdentifier', () => {
  it('creates a composite key from channelId and threadTs', () => {
    const id = new SessionIdentifier('C123', '1234.5678');
    expect(id.toString()).toBe('C123:1234.5678');
  });

  it('throws when channelId is empty', () => {
    expect(() => new SessionIdentifier('', '1234.5678')).toThrow();
  });

  it('throws when threadTs is empty', () => {
    expect(() => new SessionIdentifier('C123', '')).toThrow();
  });

  it('parses from string', () => {
    const id = SessionIdentifier.fromString('C123:1234.5678');
    expect(id.channelId).toBe('C123');
    expect(id.threadTs).toBe('1234.5678');
  });

  it('equals works correctly', () => {
    const a = new SessionIdentifier('C123', '1234.5678');
    const b = new SessionIdentifier('C123', '1234.5678');
    const c = new SessionIdentifier('C456', '1234.5678');
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });
});

describe('SessionManager', () => {
  let manager: SessionManager;
  let mockRepo: ReturnType<typeof createMockRepo>;

  beforeEach(() => {
    mockRepo = createMockRepo();
    manager = new SessionManager({
      cursorCommand: 'cursor',
      workingDir: '/fake',
      conversationRepo: mockRepo as any,
      evictionIntervalMs: 60_000, // long interval to avoid interference
    });
  });

  afterEach(() => {
    manager.stop();
  });

  it('creates a new session for a new composite key', async () => {
    manager.start();
    const id = new SessionIdentifier('C123', '1234.5678');
    const handle = await manager.getOrCreateSession(id, 'U001');
    expect(handle).not.toBeNull();
    expect(handle!.id.equals(id)).toBe(true);
  });

  it('returns the same handle for the same composite key', async () => {
    manager.start();
    const id = new SessionIdentifier('C123', '1234.5678');
    const handle1 = await manager.getOrCreateSession(id, 'U001');
    const handle2 = await manager.getOrCreateSession(id, 'U001');
    expect(handle1).toBe(handle2);
  });

  it('returns different handles for different threadTs', async () => {
    manager.start();
    const id1 = new SessionIdentifier('C123', '1111.0000');
    const id2 = new SessionIdentifier('C123', '2222.0000');
    const handle1 = await manager.getOrCreateSession(id1, 'U001');
    const handle2 = await manager.getOrCreateSession(id2, 'U001');
    expect(handle1).not.toBe(handle2);
  });

  it('isolates sessions across different channels with same threadTs', async () => {
    manager.start();
    const id1 = new SessionIdentifier('C111', '1234.5678');
    const id2 = new SessionIdentifier('C222', '1234.5678');
    const handle1 = await manager.getOrCreateSession(id1, 'U001');
    const handle2 = await manager.getOrCreateSession(id2, 'U001');
    expect(handle1).not.toBe(handle2);
  });

  it('returns null when session limit is reached', async () => {
    const limited = new SessionManager({
      cursorCommand: 'cursor',
      workingDir: '/fake',
      conversationRepo: mockRepo as any,
      maxActiveSessions: 1,
      evictionIntervalMs: 60_000,
    });
    limited.start();

    const id1 = new SessionIdentifier('C123', '1111.0000');
    const id2 = new SessionIdentifier('C123', '2222.0000');
    const handle1 = await limited.getOrCreateSession(id1, 'U001');
    expect(handle1).not.toBeNull();

    const handle2 = await limited.getOrCreateSession(id2, 'U001');
    expect(handle2).toBeNull();

    limited.stop();
  });

  it('evicts submitted sessions to free capacity', async () => {
    const limited = new SessionManager({
      cursorCommand: 'cursor',
      workingDir: '/fake',
      conversationRepo: mockRepo as any,
      maxActiveSessions: 1,
      evictionIntervalMs: 60_000,
    });
    limited.start();

    const id1 = new SessionIdentifier('C123', '1111.0000');
    await limited.getOrCreateSession(id1, 'U001');
    limited.markPlanSubmitted(id1);

    // Now should evict id1 and create id2
    const id2 = new SessionIdentifier('C123', '2222.0000');
    const handle2 = await limited.getOrCreateSession(id2, 'U001');
    expect(handle2).not.toBeNull();

    limited.stop();
  });

  it('recovers session from database when channelId matches', async () => {
    manager.start();
    mockRepo.loadConversation.mockReturnValueOnce({
      threadTs: '1234.5678',
      channelId: 'C123',
      userId: 'U001',
      messages: [],
      extractedPlan: null,
      planSubmitted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const id = new SessionIdentifier('C123', '1234.5678');
    const handle = await manager.getOrCreateSession(id, 'U001');
    expect(handle).not.toBeNull();
    // Should have called loadConversation for recovery
    expect(mockRepo.loadConversation).toHaveBeenCalledWith('1234.5678');
  });

  it('recovers session from database when channelId is empty (backward compat)', async () => {
    manager.start();
    mockRepo.loadConversation.mockReturnValueOnce({
      threadTs: '1234.5678',
      channelId: '',
      userId: 'U001',
      messages: [],
      extractedPlan: null,
      planSubmitted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const id = new SessionIdentifier('C123', '1234.5678');
    const handle = await manager.getOrCreateSession(id, 'U001');
    expect(handle).not.toBeNull();
  });

  it('persists channelId and userId when creating a new session', async () => {
    manager.start();
    const id = new SessionIdentifier('C123', '1234.5678');
    await manager.getOrCreateSession(id, 'U001');

    expect(mockRepo.saveConversation).toHaveBeenCalledWith(
      '1234.5678',
      [],
      null,
      false,
      'C123',
      'U001',
    );
  });

  it('getMetrics returns correct counts', async () => {
    manager.start();
    const id1 = new SessionIdentifier('C123', '1111.0000');
    const id2 = new SessionIdentifier('C123', '2222.0000');
    await manager.getOrCreateSession(id1, 'U001');
    await manager.getOrCreateSession(id2, 'U002');
    manager.markPlanSubmitted(id1);

    const metrics = manager.getMetrics();
    expect(metrics.totalActive).toBe(2);
    expect(metrics.submitted).toBe(1);
  });

  it('evictSession removes a specific session', async () => {
    manager.start();
    const id = new SessionIdentifier('C123', '1234.5678');
    await manager.getOrCreateSession(id, 'U001');
    expect(manager.getMetrics().totalActive).toBe(1);

    const evicted = manager.evictSession(id);
    expect(evicted).toBe(true);
    expect(manager.getMetrics().totalActive).toBe(0);
  });

  it('persists plan_submitted to database', async () => {
    manager.start();
    const id = new SessionIdentifier('C123', '1234.5678');
    await manager.getOrCreateSession(id, 'U001');

    // Clear the initial saveConversation call from session creation
    mockRepo.saveConversation.mockClear();

    manager.markPlanSubmitted(id);

    expect(mockRepo.saveConversation).toHaveBeenCalledWith(
      '1234.5678', [], undefined, true,
    );
  });

  it('logs reason when conversation not found in DB', async () => {
    const logCalls: string[] = [];
    const loggingManager = new SessionManager({
      cursorCommand: 'cursor',
      workingDir: '/fake',
      conversationRepo: mockRepo as any,
      evictionIntervalMs: 60_000,
      log: (_src, _lvl, msg) => { logCalls.push(msg); },
    });
    loggingManager.start();

    const id = new SessionIdentifier('C123', 'ts-new');
    mockRepo.loadConversation.mockReturnValue(null);
    await loggingManager.getOrCreateSession(id, 'U1');

    expect(logCalls.some(m => m.includes('No persisted conversation'))).toBe(true);
    loggingManager.stop();
  });

  it('logs channel mismatch when conversation found with wrong channelId', async () => {
    const logCalls: Array<{ level: string; msg: string }> = [];
    const loggingManager = new SessionManager({
      cursorCommand: 'cursor',
      workingDir: '/fake',
      conversationRepo: mockRepo as any,
      evictionIntervalMs: 60_000,
      log: (_src, level, msg) => { logCalls.push({ level, msg }); },
    });
    loggingManager.start();

    mockRepo.loadConversation.mockReturnValueOnce({
      threadTs: '1234.5678',
      channelId: 'C999',
      userId: 'U001',
      messages: [],
      extractedPlan: null,
      planSubmitted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const id = new SessionIdentifier('C123', '1234.5678');
    await loggingManager.getOrCreateSession(id, 'U001');

    expect(logCalls.some(e => e.level === 'warn' && e.msg.includes('Channel mismatch'))).toBe(true);
    loggingManager.stop();
  });

  it('stop disposes all sessions and clears timer', async () => {
    manager.start();
    const id = new SessionIdentifier('C123', '1234.5678');
    const handle = await manager.getOrCreateSession(id, 'U001');

    manager.stop();
    expect(manager.getMetrics().totalActive).toBe(0);

    // Sending a message after dispose should throw
    await expect(handle!.sendMessage('test')).rejects.toThrow('disposed');
  });
});
