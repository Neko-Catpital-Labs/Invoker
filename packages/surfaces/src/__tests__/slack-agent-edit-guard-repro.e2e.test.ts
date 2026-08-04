import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlanConversation } from '../slack/plan-conversation.js';
import * as child_process from 'node:child_process';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof child_process>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const mockSpawn = vi.mocked(child_process.spawn);

function plannerTurn(stdout: string, sideEffect?: () => void): void {
  mockSpawn.mockImplementationOnce(() => {
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    setTimeout(() => {
      sideEffect?.();
      proc.stdout.emit('data', Buffer.from(stdout));
      proc.emit('close', 0);
    }, 0);
    return proc;
  });
}

function initSandboxRepo(): string {
  const workingDir = mkdtempSync(join(tmpdir(), 'invoker-agent-edit-repro-'));
  execFileSync('git', ['init'], { cwd: workingDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workingDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: workingDir });
  writeFileSync(join(workingDir, 'index.css'), ':root { --background: 10 10 10; }\n');
  execFileSync('git', ['add', '.'], { cwd: workingDir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: workingDir });
  return workingDir;
}

function porcelain(workingDir: string): string {
  return execFileSync('git', ['status', '--porcelain'], { cwd: workingDir, encoding: 'utf8' }).trim();
}

describe('Slack agent-mode pre-approval edit guard (repro for the pink-theme incident)', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('a mention turn that edits a tracked file has the edit reverted, keeps new repro artifacts, and says so in the reply', async () => {
    const workingDir = initSandboxRepo();
    const conversation = new PlanConversation({ mode: 'agent', workingDir, threadTs: 'thread-pink' });
    try {
      plannerTurn(
        'Done. Changed: index.css retheme to pink.',
        () => {
          writeFileSync(join(workingDir, 'index.css'), ':root { --background: 40 14 28; }\n');
          writeFileSync(join(workingDir, 'repro.txt'), 'repro artifact\n');
        },
      );

      const reply = await conversation.sendMessage('lets change the theme of the app from black to pink');

      expect(porcelain(workingDir)).toBe('?? repro.txt');
      expect(readFileSync(join(workingDir, 'index.css'), 'utf8')).toContain('10 10 10');
      expect(reply).toContain('Done. Changed: index.css retheme to pink.');
      expect(reply).toContain('tracked-file edits from this pre-approval session were reverted');
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
    }
  });

  it('the agent-mode system prompt no longer authorizes tracked-file edits', async () => {
    const workingDir = initSandboxRepo();
    const conversation = new PlanConversation({ mode: 'agent', workingDir, threadTs: 'thread-pink' });
    try {
      plannerTurn('Understood.');
      await conversation.sendMessage('lets change the theme of the app from black to pink');

      const prompt = mockSpawn.mock.calls[0][1]!.filter((a): a is string => typeof a === 'string').join('\n');
      expect(prompt).toContain('cannot modify tracked files');
      expect(prompt).toContain('route code changes through a plan');
      expect(prompt).not.toContain('edit code, and run focused verification when useful');
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
    }
  });
});
