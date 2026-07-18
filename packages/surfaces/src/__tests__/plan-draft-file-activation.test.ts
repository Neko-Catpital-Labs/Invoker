import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as child_process from 'node:child_process';
import { PlanConversation } from '../slack/plan-conversation.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof child_process>();
  return { ...actual, spawn: vi.fn() };
});

const mockSpawn = vi.mocked(child_process.spawn);

function fakePlannerChild(stdout: string, beforeClose?: () => void): any {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  setTimeout(() => {
    beforeClose?.();
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    proc.emit('close', 0);
  }, 0);
  return proc;
}

describe('plan draft file activation side', () => {
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
    expect(prompt).toContain('HOW TO DELIVER A PLAN');
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
    writeFileSync(path, 'name: "Stale plan"\ntasks:\n  - id: stale\n    description: stale\n    dependencies: []\n', 'utf8');

    mockSpawn.mockReturnValueOnce(fakePlannerChild('Drafted the plan. Summary: one step.'));
    await conversation.sendMessage('Draft it');

    expect(existsSync(path)).toBe(false);
    expect(conversation.getDraftedPlan()).toBeNull();
  });

  it('falls back to the newest inline plan after clearing a stale draft file', async () => {
    const conversation = new PlanConversation({ workingDir, threadTs: 'abc-123' });
    const path = conversation.planDraftFilePath();
    if (!path) throw new Error('expected a plan draft path');
    mkdirSync(join(workingDir, '.invoker', 'plan-drafts'), { recursive: true });
    writeFileSync(path, 'name: "Stale file plan"\ntasks:\n  - id: stale\n    description: stale\n    dependencies: []\n', 'utf8');

    mockSpawn.mockReturnValueOnce(fakePlannerChild([
      'Here is the newer plan.',
      '',
      '```yaml',
      'name: "Newest inline plan"',
      'tasks:',
      '  - id: newest',
      '    description: newest',
      '    dependencies: []',
      '```',
    ].join('\n')));
    await conversation.sendMessage('Draft the newer plan');

    const drafted = conversation.getDraftedPlan();
    expect(drafted).not.toBeNull();
    expect(drafted).toContain('Newest inline plan');
    expect(drafted).not.toContain('Stale file plan');

    const reply = await conversation.sendMessage('yes');
    expect(reply).toContain('Newest inline plan');
    expect(reply).not.toContain('Stale file plan');
  });

  it('returns and summarizes only the newest file-backed draft across consecutive turns', async () => {
    const conversation = new PlanConversation({ workingDir, threadTs: 'abc-123' });
    const path = conversation.planDraftFilePath();
    if (!path) throw new Error('expected a plan draft path');

    const firstPlan = 'name: "First file plan"\ntasks:\n  - id: first\n    description: first\n    dependencies: []\n';
    const secondPlan = 'name: "Second file plan"\ntasks:\n  - id: second\n    description: second\n    dependencies: []\n';

    mockSpawn.mockReturnValueOnce(fakePlannerChild('Drafted first file plan.', () => {
      writeFileSync(path, firstPlan, 'utf8');
    }));
    await conversation.sendMessage('Draft the first plan');
    expect(conversation.getDraftedPlan()).toBe(firstPlan.trim());

    mockSpawn.mockReturnValueOnce(fakePlannerChild('Drafted second file plan.', () => {
      writeFileSync(path, secondPlan, 'utf8');
    }));
    await conversation.sendMessage('Revise the plan');

    const drafted = conversation.getDraftedPlan();
    expect(drafted).toBe(secondPlan.trim());
    expect(drafted).not.toContain('First file plan');

    const reply = await conversation.sendMessage('yes');
    expect(reply).toContain('Second file plan');
    expect(reply).not.toContain('First file plan');
  });
});
