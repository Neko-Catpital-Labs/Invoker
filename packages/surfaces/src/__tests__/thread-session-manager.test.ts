import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionManager, SessionIdentifier, SessionHandle } from '../slack/thread-session-manager.js';
import * as child_process from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAdapter, ConversationRepository } from '@invoker/data-store';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

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

const mockSpawn = vi.mocked(child_process.spawn);

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

  it('never trusts an empty stored channelId as a match — starts a fresh session instead of inheriting the orphaned row\'s history', async () => {
    manager.start();
    mockRepo.loadConversation.mockReturnValueOnce({
      threadTs: '1234.5678',
      channelId: '',
      userId: 'U001',
      messages: [
        { role: 'user', content: 'message from some other, unrelated conversation' },
      ],
      extractedPlan: null,
      planSubmitted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const id = new SessionIdentifier('C123', '1234.5678');
    const handle = await manager.getOrCreateSession(id, 'U001');
    expect(handle).not.toBeNull();
    // A fresh, empty session — never the orphaned row's history.
    expect(handle!.history).toEqual([]);
    // The creation path re-persists this thread with a real, non-empty channelId.
    expect(mockRepo.saveConversation).toHaveBeenCalledWith(
      '1234.5678',
      [],
      null,
      false,
      'C123',
      'U001',
      'agent',
    );
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
      'agent',
    );
  });

  it('a per-session repoUrl override wins over the manager-level default (multi-repo threads)', async () => {
    mockSpawn.mockClear();
    const multiRepoManager = new SessionManager({
      cursorCommand: 'cursor',
      workingDir: '/fake',
      conversationRepo: mockRepo as any,
      evictionIntervalMs: 60_000,
      // Simulates `defaultRepoUrl` in ~/.invoker/config.json pointed at Invoker.
      repoUrl: 'git@github.com:Neko-Catpital-Labs/Invoker.git',
      mode: 'plan',
    });
    multiRepoManager.start();

    // Simulates a Slack thread that resolved a `[repo:notarepo]` tag to a
    // different repo than the manager-level default.
    const id = new SessionIdentifier('C123', '1234.5678');
    const handle = await multiRepoManager.getOrCreateSession(id, 'U001', {
      workingDir: '/checkouts/notarepo',
      repoUrl: 'git@github.com:EdbertChan/notarepo.git',
    });
    expect(handle).not.toBeNull();

    await handle!.sendMessage('Add a health endpoint');
    const prompt = mockSpawn.mock.calls[0][1]![1] as string;

    // The thread's own resolved repo, not the manager-level default, must
    // reach the planning LLM's system prompt.
    expect(prompt).toContain('repoUrl: "git@github.com:EdbertChan/notarepo.git"');
    expect(prompt).not.toContain('Neko-Catpital-Labs/Invoker.git');

    multiRepoManager.stop();
  });

  it('falls back to the manager-level default repoUrl when a session omits its own', async () => {
    mockSpawn.mockClear();
    const singleRepoManager = new SessionManager({
      cursorCommand: 'cursor',
      workingDir: '/fake',
      conversationRepo: mockRepo as any,
      evictionIntervalMs: 60_000,
      repoUrl: 'git@github.com:Neko-Catpital-Labs/Invoker.git',
      mode: 'plan',
    });
    singleRepoManager.start();

    const id = new SessionIdentifier('C123', '9999.0000');
    const handle = await singleRepoManager.getOrCreateSession(id, 'U001');
    expect(handle).not.toBeNull();

    await handle!.sendMessage('Add a health endpoint');
    const prompt = mockSpawn.mock.calls[0][1]![1] as string;
    expect(prompt).toContain('repoUrl: "git@github.com:Neko-Catpital-Labs/Invoker.git"');

    singleRepoManager.stop();
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

// Repro: does the channelId='' "backward compat" bypass (thread-session-manager.ts:355)
// let an unrelated channel inherit another conversation's full message history?
//
// production-realistic writer of channelId='': PlanConversation.saveState()
// (plan-conversation.ts:994-1002) always calls conversationRepo.saveConversation()
// with channelId=undefined. SlackSurface.getSession()'s no-sessionManager fallback
// (slack-surface.ts:3001-3027) constructs PlanConversation directly, with no
// upfront channel-bearing save — so saveState() is that thread's *first* DB write,
// leaving channelId='' on the row. This test reproduces that write shape with the
// real (unmocked) ConversationRepository + SQLiteAdapter, then proves a totally
// different channel asking for the same thread_ts is handed the first channel's
// full conversation instead of a fresh session.
describe('SessionManager channel isolation with real persistence', () => {
  let adapter: SQLiteAdapter;
  let repo: ConversationRepository;
  let manager: SessionManager;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    repo = new ConversationRepository(adapter, silentLogger);
    manager = new SessionManager({
      cursorCommand: 'cursor',
      workingDir: '/fake',
      conversationRepo: repo,
      evictionIntervalMs: 60_000,
    });
  });

  afterEach(() => {
    manager.stop();
    adapter.close();
  });

  it('does not hand an unrelated channel another conversation\'s history when the row was first written with channelId=""', async () => {
    const SHARED_THREAD_TS = '1785890000.000001';

    // Step 1: reproduce PlanConversation.saveState()'s exact call shape — the
    // real production signature when it is the first writer for a thread
    // (channelId and userId both omitted, i.e. undefined).
    repo.saveConversation(
      SHARED_THREAD_TS,
      [
        { role: 'user', content: 'Add real enforcement for silent catch blocks — no ESLint here, so it has to be a custom check:no-silent-catch script.' },
        { role: 'assistant', content: 'Enumeration shows 57 silent .catch() handlers and an unreliable 697 try/catch count. Pick granularity: 1 workflow per violation or per file?' },
      ],
      null,
      false,
      // channelId, userId, mode all omitted — matches plan-conversation.ts:994-1002
    );

    const persistedAsWritten = repo.loadConversation(SHARED_THREAD_TS);
    expect(persistedAsWritten?.channelId).toBe('');

    // Step 2: a completely unrelated channel — a different Slack conversation
    // about closing empty PRs — happens to ask for the exact same thread_ts
    // (this is what SlackSurface.recoverActiveConversations() does on restart:
    // `entry.channelId || this.channelId`, slack-surface.ts:3079-3082, silently
    // substitutes the bot's default channel whenever the stored channelId is '').
    manager.start();
    const unrelatedChannelId = new SessionIdentifier('C-CLOSE-EMPTY-PRS', SHARED_THREAD_TS);
    const handle = await manager.getOrCreateSession(unrelatedChannelId, 'U-CHIEF-CAT-OFFICER');

    expect(handle).not.toBeNull();
    // FIXED BEHAVIOR: an empty stored channelId is never trusted as a match, so
    // the "close empty PRs" channel gets a fresh, empty session — never the
    // unrelated silent-catch/lint-policy conversation's history.
    expect(handle!.history).toEqual([]);
  });

  it('does NOT bleed when the row was first written with a real channelId (control case)', async () => {
    const SHARED_THREAD_TS = '1785890000.000002';

    // Same shape as above, but simulating the normal getOrCreateSession path,
    // which always supplies a real channelId on first write.
    repo.saveConversation(
      SHARED_THREAD_TS,
      [{ role: 'user', content: 'unrelated content that belongs to channel C-ORIGINAL' }],
      null,
      false,
      'C-ORIGINAL',
      'U-SOMEONE',
      'agent',
    );

    manager.start();
    const otherChannelId = new SessionIdentifier('C-DIFFERENT', SHARED_THREAD_TS);
    const handle = await manager.getOrCreateSession(otherChannelId, 'U-OTHER');

    expect(handle).not.toBeNull();
    // A real, non-empty stored channelId that doesn't match is NOT trusted —
    // a brand-new, empty session is created instead. No bleed.
    expect(handle!.history).toEqual([]);
  });

  it('never writes channelId="" — PlanConversation.saveState() persists the real channelId on every turn', async () => {
    const THREAD_TS = '1785890000.000003';
    manager.start();
    const id = new SessionIdentifier('C-REAL-CHANNEL', THREAD_TS);
    const handle = await manager.getOrCreateSession(id, 'U001');
    expect(handle).not.toBeNull();

    // sendMessage triggers PlanConversation.saveState() internally (child_process.spawn
    // is mocked at module level in this file — see the top of this file).
    await handle!.sendMessage('hello');

    const persisted = repo.loadConversation(THREAD_TS);
    expect(persisted?.channelId).toBe('C-REAL-CHANNEL');
    expect(persisted?.channelId).not.toBe('');
  });
});

// SessionHandle.lastTurnPlanIntentSignal / lastTurnDraftPlanText are pure
// proxy getters onto the wrapped PlanConversation. Every other test in this
// file either stops short of reading them or (elsewhere in the package)
// exercises PlanConversation directly, bypassing SessionHandle/SessionManager
// entirely. These prove the proxy through the real pooling path production
// Slack traffic takes: getOrCreateSession -> sendMessage -> getter.
describe('SessionHandle real-conversation proxy getters', () => {
  let workingDir: string;
  let manager: SessionManager;
  let mockRepo: ReturnType<typeof createMockRepo>;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'session-handle-proxy-'));
    mockRepo = createMockRepo();
    // No `mode` override: SessionManager defaults fresh sessions to 'agent'
    // (thread-session-manager.ts:279,401), which is what gates
    // lastTurnPlanIntentSignal open.
    manager = new SessionManager({
      cursorCommand: 'cursor',
      workingDir,
      conversationRepo: mockRepo as any,
      evictionIntervalMs: 60_000,
    });
    manager.start();
  });

  afterEach(() => {
    manager.stop();
    rmSync(workingDir, { recursive: true, force: true });
  });

  function mockChildThatWrites(write: () => void, stdout: string): void {
    mockSpawn.mockImplementationOnce(() => {
      const { EventEmitter } = require('node:events');
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn();
      setTimeout(() => {
        write();
        proc.stdout.emit('data', Buffer.from(stdout));
        proc.emit('close', 0);
      }, 0);
      return proc;
    });
  }

  it('proxies lastTurnPlanIntentSignal through a real getOrCreateSession -> sendMessage -> getter path', async () => {
    const id = new SessionIdentifier('C123', 'thread-proxy-intent');
    const handle = await manager.getOrCreateSession(id, 'U001');
    expect(handle).not.toBeNull();

    const signalDir = join(workingDir, '.invoker', 'plan-intent');
    mkdirSync(signalDir, { recursive: true });
    const signalPath = join(signalDir, 'thread-proxy-intent.json');
    mockChildThatWrites(
      () => writeFileSync(signalPath, JSON.stringify({ wantsPlan: true }), 'utf8'),
      'sure, want me to draft one for that?',
    );

    await handle!.sendMessage('submit it');

    expect(handle!.lastTurnPlanIntentSignal).toEqual({ wantsPlan: true, reason: undefined });
  });

  it('proxies lastTurnDraftPlanText through a real getOrCreateSession -> sendMessage -> getter path', async () => {
    const id = new SessionIdentifier('C123', 'thread-proxy-draft');
    const handle = await manager.getOrCreateSession(id, 'U001');
    expect(handle).not.toBeNull();

    const draftDir = join(workingDir, '.invoker', 'plan-drafts');
    mkdirSync(draftDir, { recursive: true });
    const draftPath = join(draftDir, 'thread-proxy-draft.yaml');
    const plan = 'name: "Proxy Plan"\nonFinish: none\ntasks:\n  - id: t\n    description: "d"\n    command: "pnpm test"\n    dependencies: []\n';
    mockChildThatWrites(
      () => writeFileSync(draftPath, plan, 'utf8'),
      'drafted the plan, see file',
    );

    await handle!.sendMessage('draft a plan');

    expect(handle!.lastTurnDraftPlanText).toBe(plan.trim());
  });
});
