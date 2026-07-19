import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionManager, SessionIdentifier } from '../slack/thread-session-manager.js';
import * as child_process from 'node:child_process';

// Proves that a single running Invoker Slack bot (one SessionManager) can
// hold one conversation targeting `notarepo` and another targeting
// `Invoker` at the same time, in the same process, without either thread's
// resolved repo or message history leaking into the other's planning
// prompt — whether the threads are driven one turn at a time in sequence,
// or genuinely concurrently via Promise.all.

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

function createMockRepo() {
  return {
    saveConversation: vi.fn(),
    loadConversation: vi.fn().mockReturnValue(null),
    deleteConversation: vi.fn(),
    listActiveConversations: vi.fn().mockReturnValue([]),
    cleanupOldConversations: vi.fn().mockReturnValue(0),
  };
}

const INVOKER_REPO = 'git@github.com:Neko-Catpital-Labs/Invoker.git';
const NOTAREPO_REPO = 'git@github.com:EdbertChan/notarepo.git';

describe('multi-repo conversation isolation (one bot, two repos)', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager({
      cursorCommand: 'cursor',
      workingDir: '/fake',
      conversationRepo: createMockRepo() as any,
      evictionIntervalMs: 60_000,
      // Manager-level default repo — deliberately Invoker's, so that a
      // leak would silently make the notarepo thread look correct.
      repoUrl: INVOKER_REPO,
      mode: 'plan',
    });
    manager.start();
    mockSpawn.mockClear();
  });

  afterEach(() => {
    manager.stop();
  });

  function promptForCall(callIndex: number): string {
    return mockSpawn.mock.calls[callIndex][1]![1] as string;
  }

  it('keeps two threads separated when the user switches back and forth between them', async () => {
    const invokerThread = new SessionIdentifier('C-lobby', '1111.0000');
    const notarepoThread = new SessionIdentifier('C-lobby', '2222.0000');

    const invokerHandle = await manager.getOrCreateSession(invokerThread, 'U001', {
      workingDir: '/checkouts/invoker',
      repoUrl: INVOKER_REPO,
    });
    const notarepoHandle = await manager.getOrCreateSession(notarepoThread, 'U001', {
      workingDir: '/checkouts/notarepo',
      repoUrl: NOTAREPO_REPO,
    });
    expect(invokerHandle).not.toBeNull();
    expect(notarepoHandle).not.toBeNull();

    // Turn 1, Invoker thread.
    await invokerHandle!.sendMessage('Add a retry helper to the execution engine');
    const invokerTurn1 = promptForCall(0);
    expect(invokerTurn1).toContain(`repoUrl: "${INVOKER_REPO}"`);
    expect(invokerTurn1).not.toContain(NOTAREPO_REPO);
    expect(invokerTurn1).not.toContain('Add a health endpoint to notarepo');

    // User switches to the notarepo thread — turn 1 there.
    await notarepoHandle!.sendMessage('Add a health endpoint to notarepo');
    const notarepoTurn1 = promptForCall(1);
    expect(notarepoTurn1).toContain(`repoUrl: "${NOTAREPO_REPO}"`);
    expect(notarepoTurn1).not.toContain(INVOKER_REPO);
    expect(notarepoTurn1).not.toContain('Add a retry helper to the execution engine');

    // Back to the Invoker thread — turn 2 must still target Invoker and
    // must not have picked up the notarepo thread's message in between.
    await invokerHandle!.sendMessage('Also add a unit test for the retry helper');
    const invokerTurn2 = promptForCall(2);
    expect(invokerTurn2).toContain(`repoUrl: "${INVOKER_REPO}"`);
    expect(invokerTurn2).not.toContain(NOTAREPO_REPO);
    expect(invokerTurn2).toContain('Add a retry helper to the execution engine'); // own history
    expect(invokerTurn2).not.toContain('Add a health endpoint to notarepo'); // not the other thread's

    // And the notarepo thread's next turn must still target notarepo and
    // must not have picked up the Invoker thread's second message.
    await notarepoHandle!.sendMessage('Also add validation for the health payload');
    const notarepoTurn2 = promptForCall(3);
    expect(notarepoTurn2).toContain(`repoUrl: "${NOTAREPO_REPO}"`);
    expect(notarepoTurn2).not.toContain(INVOKER_REPO);
    expect(notarepoTurn2).toContain('Add a health endpoint to notarepo'); // own history
    expect(notarepoTurn2).not.toContain('Also add a unit test for the retry helper'); // not the other thread's
  });

  it('keeps two threads separated when driven truly concurrently', async () => {
    const invokerThread = new SessionIdentifier('C-lobby', '3333.0000');
    const notarepoThread = new SessionIdentifier('C-lobby', '4444.0000');

    const [invokerHandle, notarepoHandle] = await Promise.all([
      manager.getOrCreateSession(invokerThread, 'U001', {
        workingDir: '/checkouts/invoker',
        repoUrl: INVOKER_REPO,
      }),
      manager.getOrCreateSession(notarepoThread, 'U002', {
        workingDir: '/checkouts/notarepo',
        repoUrl: NOTAREPO_REPO,
      }),
    ]);
    expect(invokerHandle).not.toBeNull();
    expect(notarepoHandle).not.toBeNull();

    const [invokerReply, notarepoReply] = await Promise.all([
      invokerHandle!.sendMessage('Plan the retry helper'),
      notarepoHandle!.sendMessage('Plan the health endpoint'),
    ]);
    expect(invokerReply).toBeTruthy();
    expect(notarepoReply).toBeTruthy();

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    const prompts = mockSpawn.mock.calls.map((call) => call[1]![1] as string);
    const invokerPrompt = prompts.find((p) => p.includes('Plan the retry helper'))!;
    const notarepoPrompt = prompts.find((p) => p.includes('Plan the health endpoint'))!;

    expect(invokerPrompt).toContain(`repoUrl: "${INVOKER_REPO}"`);
    expect(invokerPrompt).not.toContain(NOTAREPO_REPO);
    expect(invokerPrompt).not.toContain('Plan the health endpoint');

    expect(notarepoPrompt).toContain(`repoUrl: "${NOTAREPO_REPO}"`);
    expect(notarepoPrompt).not.toContain(INVOKER_REPO);
    expect(notarepoPrompt).not.toContain('Plan the retry helper');
  });
});
