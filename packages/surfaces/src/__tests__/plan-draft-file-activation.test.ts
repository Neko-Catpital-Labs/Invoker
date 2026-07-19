import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { parse as parseYaml } from 'yaml';
import * as childProcess from 'node:child_process';
import { PlanConversation, isConfirmation } from '../slack/plan-conversation.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const mockSpawn = vi.mocked(childProcess.spawn);

function createMockProcess(stdout: string): any {
  const proc = new EventEmitter() as any;
  const stdoutEmitter = new EventEmitter();
  proc.stdout = stdoutEmitter;
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();

  setTimeout(() => {
    stdoutEmitter.emit('data', Buffer.from(stdout));
    proc.emit('close', 0);
  }, 0);

  return proc;
}

function mockPlannerResponse(text: string): void {
  mockSpawn.mockReturnValueOnce(createMockProcess(text));
}

const VALID_PLAN_RESPONSE = `Here is the plan:

\`\`\`yaml
name: "Draft Activation"
onFinish: none
tasks:
  - id: implement
    description: "Implement the change"
    prompt: "Do the work"
    dependencies: []
\`\`\`

Reply \`submit\` to submit it.`;

describe('plan draft file activation', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('requires the exact submit line as a standalone post-plan instruction', () => {
    const conversation = new PlanConversation({});
    (conversation as any).messages.push({ role: 'user', content: 'Draft a plan' });

    const prompt = conversation.buildCursorPrompt();
    const submitLine = 'Reply `submit` to submit it.';
    const lines = prompt.split('\n');

    expect(lines.filter((line) => line === submitLine)).toHaveLength(1);
    expect(prompt.match(/Reply `submit` to submit it\./g)).toHaveLength(1);
    expect(prompt).toContain('Do NOT place that line inline in a sentence.');
  });

  it('activates the latest draft when the user replies submit', async () => {
    const conversation = new PlanConversation({});

    mockPlannerResponse(VALID_PLAN_RESPONSE);
    await conversation.sendMessage('Create the plan');

    expect(isConfirmation('submit')).toBe(true);

    const reply = await conversation.sendMessage('submit');

    expect(reply).toBe('Plan "Draft Activation" submitted for execution.');
    expect(conversation.planSubmitted).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    const submittedPlan = parseYaml(conversation.submittedPlanText!) as Record<string, unknown>;
    expect(submittedPlan.name).toBe('Draft Activation');
  });
});
