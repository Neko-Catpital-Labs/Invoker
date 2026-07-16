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
// reply is accepted as a complete turn and recorded in conversation history.
//
// A missing closing fence cannot be the signal: `extractYamlPlan` deliberately
// accepts a plan whose closing fence never arrived. The signal only truncation
// produces is an opened ```yaml block whose content no longer parses as YAML —
// it ends on an unterminated string or key. A complete plan always parses,
// closing fence or not, so this suite also pins that a valid unfenced plan is
// left untouched.

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
// the text ends mid-token, exactly as it looks when a model hits its output cap.
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

const COMPLETE_REPLY = [
  'Here is the plan we discussed.',
  '',
  '```yaml',
  'name: "Planning composer typing responsiveness"',
  'onFinish: pull_request',
  'mergeMode: external_review',
  'tasks:',
  '  - id: localize-composer-state',
  '    description: "Move planning composer text into local component state"',
  '```',
].join('\n');

describe('planner exit=0 with a cut-off reply — repro for silently accepted truncation', () => {
  let conversation: PlanConversation;

  beforeEach(() => {
    mockSpawn.mockReset();
    conversation = new PlanConversation({ plannerRetryLimit: 0 });
  });

  it('marks the reply as cut off when the planner stops mid-message', async () => {
    mockSpawn.mockReturnValueOnce(fakePlannerChild({ stdout: TRUNCATED_REPLY, exitCode: 0 }));

    const reply = await conversation.sendMessage('Draft the plan');

    // The partial text is still worth showing, but the reply must say it was cut off.
    expect(reply).toContain('cut off');
  });

  it('records the truncation in conversation history rather than storing a partial reply as complete', async () => {
    mockSpawn.mockReturnValueOnce(fakePlannerChild({ stdout: TRUNCATED_REPLY, exitCode: 0 }));

    await conversation.sendMessage('Draft the plan').catch(() => undefined);

    const assistant = conversation.history.filter((entry) => entry.role === 'assistant');
    expect(assistant.length).toBeGreaterThan(0);
    expect(assistant[assistant.length - 1].content).toContain('cut off');
  });

  it('leaves a complete reply untouched', async () => {
    mockSpawn.mockReturnValueOnce(fakePlannerChild({ stdout: COMPLETE_REPLY, exitCode: 0 }));

    const reply = await conversation.sendMessage('Draft the plan');

    expect(reply).not.toContain('cut off');
    expect(reply).toContain('localize-composer-state');
  });

  it('does not flag a complete plan whose closing fence is missing', async () => {
    // A finished plan that simply lacks its closing ``` still parses as YAML.
    // The tolerant extractor accepts it, so truncation detection must not fire.
    const noClosingFence = [
      'Here is the plan.',
      '',
      '```yaml',
      'name: Mock Plan',
      'onFinish: none',
      'tasks:',
      '  - id: first',
      '    description: First task',
      '    command: echo first',
    ].join('\n');
    mockSpawn.mockReturnValueOnce(fakePlannerChild({ stdout: noClosingFence, exitCode: 0 }));

    const reply = await conversation.sendMessage('Draft the plan');

    expect(reply).not.toContain('cut off');
  });
});
