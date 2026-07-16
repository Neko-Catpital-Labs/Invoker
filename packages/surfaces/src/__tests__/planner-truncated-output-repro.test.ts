import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as child_process from 'node:child_process';
import { PlanConversation } from '../slack/plan-conversation.js';

// Repro for planner replies that are cut off mid-message.
//
// The planner CLI streams the model's answer to stdout and exits 0 when the CLI
// itself did not fail. A model that stops early — it reached its own output
// budget — is indistinguishable from one that finished: stdout is non-empty and
// the exit code is 0. `spawnPlanner` only rejects on empty stdout, so a partial
// reply is accepted as a complete turn and recorded in conversation history with
// nothing anywhere saying the reply was cut off.
//
// This suite pins the CURRENT (buggy) behavior so the proof lands green. The fix
// slice flips these expectations to the corrected behavior.

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

// A reply that stops partway through the YAML plan: the ```yaml fence opens and
// the text ends mid-token on an unterminated quoted string, exactly as it looks
// when a model hits its output cap.
const TRUNCATED_REPLY = [
  'Here is the plan we discussed.',
  '',
  '```yaml',
  'name: "Planning composer typing responsiveness"',
  'onFinish: pull_request',
  'mergeMode: external_review',
  'tasks:',
  '  - id: localize-composer-state',
  '    description: "Move planning composer text into local component state so keystrokes stop re-rendering App; lock the fix with the fat-graph e2e b',
].join('\n');

describe('planner exit=0 with a cut-off reply — current behavior silently accepts truncation', () => {
  let conversation: PlanConversation;

  beforeEach(() => {
    mockSpawn.mockReset();
    conversation = new PlanConversation({ plannerRetryLimit: 0 });
  });

  it('accepts a cut-off reply as a complete turn with no truncation notice', async () => {
    mockSpawn.mockReturnValueOnce(fakePlannerChild({ stdout: TRUNCATED_REPLY, exitCode: 0 }));

    const reply = await conversation.sendMessage('Draft the plan');

    // BUG: the reply ends mid-word and nothing flags it as cut off.
    expect(reply).not.toContain('cut off');
    expect(reply.trimEnd().endsWith('fat-graph e2e b')).toBe(true);
  });

  it('stores the partial reply in history verbatim, as if the planner had finished', async () => {
    mockSpawn.mockReturnValueOnce(fakePlannerChild({ stdout: TRUNCATED_REPLY, exitCode: 0 }));

    await conversation.sendMessage('Draft the plan').catch(() => undefined);

    const assistant = conversation.history.filter((entry) => entry.role === 'assistant');
    expect(assistant.length).toBeGreaterThan(0);
    // BUG: history keeps the cut-off text with no marker that it was truncated.
    expect(assistant[assistant.length - 1].content).not.toContain('cut off');
  });
});
