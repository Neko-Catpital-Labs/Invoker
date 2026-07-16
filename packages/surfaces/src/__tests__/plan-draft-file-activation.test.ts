import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as child_process from 'node:child_process';
import { PlanConversation } from '../slack/plan-conversation.js';

// Activation side: the planner is told to write the full plan to the draft file
// and reply with a summary, and each turn starts from a cleared file so a prior
// turn's plan can never be mistaken for the current one.

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

describe('plan draft file — activation side', () => {
  let workingDir: string;

  beforeEach(() => {
    mockSpawn.mockReset();
    workingDir = mkdtempSync(join(tmpdir(), 'plan-draft-act-'));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it('instructs the planner to write the plan to the draft file instead of inline', () => {
    const conversation = new PlanConversation({ workingDir, threadTs: 'abc-123', plannerRetryLimit: 0 });
    const path = conversation.planDraftFilePath();
    const prompt = conversation.buildCursorPrompt();

    expect(path).not.toBeNull();
    expect(prompt).toContain(String(path));
    expect(prompt).toContain('write the COMPLETE YAML plan to the file');
    expect(prompt).toContain('for each of its tasks');
    expect(prompt).not.toContain('output the plan inside a ```yaml code block');
  });

  it('keeps the inline instruction when there is no draft file path', () => {
    const conversation = new PlanConversation({ plannerRetryLimit: 0 });
    const prompt = conversation.buildCursorPrompt();

    expect(conversation.planDraftFilePath()).toBeNull();
    expect(prompt).toContain('output the plan inside a ```yaml code block');
  });

  it('clears a stale plan file before the turn so getDraftedPlan cannot return it', async () => {
    const conversation = new PlanConversation({ workingDir, threadTs: 'abc-123', plannerRetryLimit: 0 });
    const path = conversation.planDraftFilePath();
    if (!path) throw new Error('expected a plan draft path');
    mkdirSync(join(workingDir, '.invoker', 'plan-drafts'), { recursive: true });
    writeFileSync(path, 'name: Stale plan\ntasks: []', 'utf8');

    // The planner replies with only a summary and does NOT write a new file.
    mockSpawn.mockReturnValueOnce(fakePlannerChild('Drafted the plan. Summary: one step.'));
    await conversation.sendMessage('Draft it');

    expect(existsSync(path)).toBe(false);
    expect(conversation.getDraftedPlan()).toBeNull();
  });
});
