import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import * as child_process from 'node:child_process';
import { PlanConversation } from '../slack/plan-conversation.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof child_process>();
  return { ...actual, spawn: vi.fn() };
});

const mockSpawn = vi.mocked(child_process.spawn);

function fakePlannerChild(stdout: string): any {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();

  setTimeout(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    proc.emit('close', 0);
  }, 0);

  return proc;
}

const FIRST_PLAN = [
  'name: "First file plan"',
  'onFinish: none',
  'tasks:',
  '  - id: first',
  '    description: First task',
  '    command: echo first',
].join('\n');

const SECOND_INLINE_REPLY = [
  'Here is the revised plan.',
  '',
  '```yaml',
  'name: "Second inline plan"',
  'onFinish: none',
  'tasks:',
  '  - id: second',
  '    description: Second task',
  '    command: echo second',
  '```',
].join('\n');

describe('plan draft file - activation side', () => {
  let workingDir: string;

  beforeEach(() => {
    mockSpawn.mockReset();
    workingDir = mkdtempSync(join(tmpdir(), 'plan-draft-act-'));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it('instructs the planner to write the plan to the draft file instead of inline', () => {
    const conversation = new PlanConversation({ workingDir, threadTs: 'abc-123' });
    const path = conversation.planDraftFilePath();
    const prompt = conversation.buildCursorPrompt();

    expect(path).not.toBeNull();
    expect(prompt).toContain(String(path));
    const deliveryIndex = prompt.indexOf('HOW TO DELIVER THE PLAN');
    const firstSchemaIndex = prompt.indexOf('```yaml');
    expect(deliveryIndex).toBeGreaterThanOrEqual(0);
    expect(deliveryIndex).toBeLessThan(firstSchemaIndex);
    expect(prompt).toContain('NEVER paste the YAML plan into your chat reply');
    expect(prompt).not.toContain('output the plan inside a ```yaml code block');
  });

  it('keeps the inline instruction when there is no draft file path', () => {
    const conversation = new PlanConversation({});
    const prompt = conversation.buildCursorPrompt();

    expect(conversation.planDraftFilePath()).toBeNull();
    expect(prompt).toContain('output the plan inside a ```yaml code block');
  });

  it('clears a stale plan file before the turn so getDraftedPlan cannot return it', async () => {
    const conversation = new PlanConversation({ workingDir, threadTs: 'abc-123' });
    const path = conversation.planDraftFilePath();
    if (!path) throw new Error('expected a plan draft path');
    mkdirSync(join(workingDir, '.invoker', 'plan-drafts'), { recursive: true });
    writeFileSync(path, FIRST_PLAN, 'utf8');

    mockSpawn.mockReturnValueOnce(fakePlannerChild('Drafted the plan. Summary: one step.'));
    await conversation.sendMessage('Draft it');

    expect(existsSync(path)).toBe(false);
    expect(conversation.getDraftedPlan()).toBeNull();
  });

  it('can submit a summary-only turn from the draft file while clearing that file', async () => {
    const conversation = new PlanConversation({ workingDir, threadTs: 'abc-123' });
    const path = conversation.planDraftFilePath();
    if (!path) throw new Error('expected a plan draft path');
    mkdirSync(join(workingDir, '.invoker', 'plan-drafts'), { recursive: true });
    writeFileSync(path, FIRST_PLAN, 'utf8');
    (conversation as unknown as { messages: Array<{ role: string; content: string }> })
      .messages.push({ role: 'assistant', content: 'Drafted the plan. Summary: one step.' });

    const reply = await conversation.sendMessage('yes');

    expect(reply).toBe('Plan "First file plan" submitted for execution.');
    expect(conversation.submittedPlanText).toBe(FIRST_PLAN);
    expect(conversation.planSubmitted).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('clears stale draft-file content so the next inline assistant plan wins', async () => {
    const conversation = new PlanConversation({ workingDir, threadTs: 'abc-123' });
    const path = conversation.planDraftFilePath();
    if (!path) throw new Error('expected a plan draft path');

    mockSpawn.mockReturnValueOnce(fakePlannerChild([
      '```yaml',
      FIRST_PLAN,
      '```',
    ].join('\n')));
    await conversation.sendMessage('Draft the first plan');

    mkdirSync(join(workingDir, '.invoker', 'plan-drafts'), { recursive: true });
    writeFileSync(path, FIRST_PLAN, 'utf8');

    mockSpawn.mockReturnValueOnce(fakePlannerChild(SECOND_INLINE_REPLY));
    await conversation.sendMessage('Revise the plan');

    expect(existsSync(path)).toBe(false);
    const drafted = conversation.getDraftedPlan();
    expect(drafted).not.toBeNull();
    const plan = parseYaml(drafted!) as Record<string, any>;
    expect(plan.name).toBe('Second inline plan');
    expect(plan.tasks[0].description).toBe('Second task');
    expect(drafted).not.toContain('First file plan');
  });
});
