/**
 * Planning-terminal repo binding + live-owner CLI reachability.
 *
 * Two contracts:
 *   1. A planning session bound to a repo opens its terminal in that
 *      provisioned worktree, not the owner's repoRoot; unbound sessions keep
 *      the repoRoot fallback (resolvePlanningTerminalCwd).
 *   2. The planning terminal is a first-class surface for driving the RUNNING
 *      Invoker: the request "please delete all running workflows" typed into
 *      the terminal reaches a stand-in agent CLI whose tool call runs the real
 *      `invoker-cli delete-all` against a live owner bus, and the owner's
 *      running workflows are deleted. The agent's natural-language-to-command
 *      step is a test stub (`claude` fixture script); everything downstream —
 *      terminal PTY plumbing, the real packages/cli binary, IPC discovery,
 *      `headless.exec` delegation — is production code.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { IpcBus } from '@invoker/transport';
import {
  EmbeddedTerminalManager,
  createBashTerminalBackend,
} from '../embedded-terminal-manager.js';
import {
  createPlanningTerminalAdapter,
  resolvePlanningTerminalCwd,
  type PlanningTerminalAdapter,
} from '../terminal-session-ipc.js';
import type { InAppPlanningChatSession, InAppPlanningChatSessions } from '../in-app-planner.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const CLI_ENTRY = join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js');

const noopLogger = {
  info: () => {},
  warn: () => {},
};

function makePlanningSession(
  id: string,
  overrides: Partial<InAppPlanningChatSession> = {},
): InAppPlanningChatSession {
  return {
    id,
    title: 'Ops session',
    presetKey: 'claude',
    confirmationMode: 'require',
    status: 'still_discussing',
    messages: [],
    conversation: {} as InAppPlanningChatSession['conversation'],
    terminalMode: 'chat',
    terminalOutputSnapshot: '',
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    nextMessageId: 1,
    ...overrides,
  };
}

function makeAdapter(
  sessions: InAppPlanningChatSessions,
  manager: EmbeddedTerminalManager,
  repoRoot: string,
): PlanningTerminalAdapter {
  return createPlanningTerminalAdapter({
    embeddedTerminalManager: manager,
    logger: noopLogger,
    planningChatSessions: sessions,
    getPlanningSessionStore: () => undefined,
    isPlanningTerminalWriteAllowed: () => true,
    repoRoot,
  });
}

describe('resolvePlanningTerminalCwd', () => {
  it('prefers the bound worktree when it exists', () => {
    const worktree = mkdtempSync(join(tmpdir(), 'inv-wt-'));
    try {
      expect(resolvePlanningTerminalCwd({ worktreePath: worktree }, '/repo-root')).toBe(worktree);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('falls back to repoRoot when unbound or the worktree is gone', () => {
    expect(resolvePlanningTerminalCwd({}, '/repo-root')).toBe('/repo-root');
    expect(resolvePlanningTerminalCwd({ worktreePath: '   ' }, '/repo-root')).toBe('/repo-root');
    expect(
      resolvePlanningTerminalCwd({ worktreePath: '/definitely/not/a/real/dir' }, '/repo-root'),
    ).toBe('/repo-root');
  });

  it('falls back to repoRoot when the worktree path is a regular file', () => {
    const worktreeDir = mkdtempSync(join(tmpdir(), 'inv-wt-'));
    const filePath = join(worktreeDir, 'not-a-dir');
    writeFileSync(filePath, 'not a directory');
    try {
      expect(resolvePlanningTerminalCwd({ worktreePath: filePath }, '/repo-root')).toBe(
        '/repo-root',
      );
    } finally {
      rmSync(worktreeDir, { recursive: true, force: true });
    }
  });
});

describe('planning terminal repo binding', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  it('opens the terminal in the session worktree, and in repoRoot when unbound', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'inv-wt-'));
    const repoRoot = mkdtempSync(join(tmpdir(), 'inv-root-'));
    cleanups.push(() => rmSync(worktree, { recursive: true, force: true }));
    cleanups.push(() => rmSync(repoRoot, { recursive: true, force: true }));

    const spawns: Array<{ cwd: string }> = [];
    const manager = new EmbeddedTerminalManager({
      backend: {
        name: 'bash',
        spawn(opts) {
          spawns.push({ cwd: opts.cwd });
          return {
            write() {},
            resize() {},
            getAppliedSize: () => null,
            close() {},
          };
        },
      },
    });
    const sessions: InAppPlanningChatSessions = new Map([
      ['bound', makePlanningSession('bound', { worktreePath: worktree })],
      ['unbound', makePlanningSession('unbound')],
    ]);
    const adapter = makeAdapter(sessions, manager, repoRoot);

    const bound = await adapter.open('bound');
    expect(bound.opened).toBe(true);
    expect(spawns[0]?.cwd).toBe(worktree);
    expect(bound.session?.cwd).toBe(worktree);

    const unbound = await adapter.open('unbound');
    expect(unbound.opened).toBe(true);
    expect(spawns[1]?.cwd).toBe(repoRoot);
  });
});

describe('planning terminal drives the running invoker', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  beforeAll(() => {
    if (!existsSync(CLI_ENTRY)) {
      execFileSync('pnpm', ['--filter', '@invoker/cli', 'build'], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
        timeout: 180_000,
      });
    }
  });

  it('"please delete all running workflows" typed into the terminal runs invoker-cli delete-all against the live owner', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'inv-wt-'));
    cleanups.push(() => rmSync(worktree, { recursive: true, force: true }));

    // Short socket path: macOS sun_path is 104 bytes.
    const sockDir = mkdtempSync(join('/tmp', 'inv-s-'));
    const socketPath = join(sockDir, 's.sock');
    cleanups.push(() => rmSync(sockDir, { recursive: true, force: true }));

    // ── Live owner fixture: real IPC bus server with running workflows ──
    const workflows = new Map<string, { status: string }>([
      ['wf-run-1', { status: 'running' }],
      ['wf-run-2', { status: 'running' }],
    ]);
    const execRequests: unknown[] = [];
    const ownerBus = new IpcBus(socketPath);
    await ownerBus.ready();
    cleanups.push(() => ownerBus.disconnect());
    ownerBus.onRequest('headless.owner-ping', async () => ({
      ownerId: 'test-owner',
      mode: 'standalone',
    }));
    ownerBus.onRequest('headless.exec', async (req: unknown) => {
      execRequests.push(req);
      const { args } = req as { args: string[] };
      if (args[0] === 'delete-all') workflows.clear();
      return { ok: true };
    });

    // ── Stand-in agent CLI: maps the request to its invoker tool call ──
    const claudeStub = join(worktree, 'claude');
    writeFileSync(
      claudeStub,
      [
        '#!/bin/bash',
        '# Test stand-in for the agent CLI: for this planning request the',
        '# agent\'s tool call is the invoker delete-all mutation.',
        'if [[ "$*" == *"please delete all running workflows"* ]]; then',
        '  exec invoker-cli delete-all',
        'fi',
        'echo "unexpected prompt: $*" >&2',
        'exit 1',
        '',
      ].join('\n'),
    );
    chmodSync(claudeStub, 0o755);
    const cliShim = join(worktree, 'invoker-cli');
    writeFileSync(
      cliShim,
      `#!/bin/bash\nexec "${process.execPath}" "${CLI_ENTRY}" "$@"\n`,
    );
    chmodSync(cliShim, 0o755);

    // ── Real planning terminal (real bash child) over the adapter ──
    const manager = new EmbeddedTerminalManager({ backend: createBashTerminalBackend() });
    const sessions: InAppPlanningChatSessions = new Map([
      ['ops', makePlanningSession('ops', { worktreePath: worktree })],
    ]);
    const adapter = makeAdapter(sessions, manager, '/tmp');

    let output = '';
    manager.on('output', (event: { data: string }) => {
      output += event.data;
    });

    const opened = await adapter.open('ops');
    expect(opened.opened).toBe(true);
    const sessionId = opened.session!.sessionId;
    cleanups.push(() => {
      manager.close(sessionId);
    });
    expect(opened.session?.cwd).toBe(worktree);

    const wrote = adapter.write(
      sessionId,
      `INVOKER_IPC_SOCKET='${socketPath}' PATH="$PWD:$PATH" claude "please delete all running workflows"\n`,
    );
    expect(wrote.ok).toBe(true);

    await vi.waitFor(
      () => {
        expect(output).toContain('delete-all accepted by live owner.');
      },
      { timeout: 20_000, interval: 250 },
    );

    expect(execRequests).toEqual([{ args: ['delete-all'], noTrack: true }]);
    expect(workflows.size).toBe(0);
  }, 30_000);
});
