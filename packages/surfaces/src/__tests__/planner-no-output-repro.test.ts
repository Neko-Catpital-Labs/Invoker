import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as child_process from 'node:child_process';
import { PlanConversation } from '../slack/plan-conversation.js';

// This test reproduces the bug where the planner CLI (Cursor/Codex/etc.) exits
// with code 0 but writes nothing to stdout — commonly because a silent
// authentication/tool-permission/context-limit failure ends up on stderr while
// the wrapper still reports success. Before the fix, `spawnPlanner` resolved
// with the literal placeholder `"(no output)"`. That placeholder then landed in
// the in-app planning chat as if the planner had answered, hiding the real
// failure from the user. The fix converts that "success with no output" case
// into a rejection whose message surfaces the stderr tail so the caller can
// treat it as the error it is.

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof child_process>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const mockSpawn = vi.mocked(child_process.spawn);

interface FakeChildOptions {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

function fakePlannerChild({ stdout = '', stderr = '', exitCode = 0 }: FakeChildOptions): any {
  const proc = new EventEmitter() as any;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  proc.stdout = stdoutEmitter;
  proc.stderr = stderrEmitter;
  proc.kill = vi.fn();

  setTimeout(() => {
    if (stdout) stdoutEmitter.emit('data', Buffer.from(stdout));
    if (stderr) stderrEmitter.emit('data', Buffer.from(stderr));
    proc.emit('close', exitCode);
  }, 0);

  return proc;
}

describe('planner exit=0 with no stdout — repro for hidden "(no output)" placeholder', () => {
  let conversation: PlanConversation;

  beforeEach(() => {
    mockSpawn.mockReset();
    // Pin retries off so this suite isolates the single-attempt semantics that
    // the "(no output)" placeholder fix targets; retry behavior is covered by
    // planner-retry-repro.test.ts.
    conversation = new PlanConversation({ plannerRetryLimit: 0 });
  });

  it('rejects instead of resolving with the "(no output)" placeholder when planner exits 0 with empty stdout', async () => {
    mockSpawn.mockReturnValueOnce(fakePlannerChild({ stdout: '', stderr: '', exitCode: 0 }));

    const promise = conversation.sendMessage('Any prompt');
    const outcome = await promise.then(
      (reply) => ({ kind: 'resolved' as const, reply }),
      (err: Error) => ({ kind: 'rejected' as const, err }),
    );

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'resolved') {
      expect(outcome.reply).not.toBe('(no output)');
      expect(outcome.reply).not.toBe('');
    } else {
      expect(outcome.err.message).toMatch(/no output|no stdout/i);
    }
  });

  it('includes the stderr tail in the rejection when the planner wrote diagnostics before exiting 0', async () => {
    const stderrTail = 'auth: session expired; please re-authenticate';
    mockSpawn.mockReturnValueOnce(fakePlannerChild({ stdout: '', stderr: stderrTail, exitCode: 0 }));

    const outcome = await conversation.sendMessage('Any prompt').then(
      (reply) => ({ kind: 'resolved' as const, reply }),
      (err: Error) => ({ kind: 'rejected' as const, err }),
    );

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.err.message).toContain(stderrTail);
    }
  });

  it('does not append the "(no output)" placeholder to the conversation history when the planner is silent', async () => {
    mockSpawn.mockReturnValueOnce(fakePlannerChild({ stdout: '', stderr: '', exitCode: 0 }));

    await conversation.sendMessage('Any prompt').catch(() => undefined);

    const assistantEntries = conversation.history.filter((entry) => entry.role === 'assistant');
    for (const entry of assistantEntries) {
      expect(entry.content).not.toBe('(no output)');
    }
  });
});
