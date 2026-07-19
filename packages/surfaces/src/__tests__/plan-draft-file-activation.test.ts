import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import * as child_process from 'node:child_process';
import { PlanConversation, isConfirmation } from '../slack/plan-conversation.js';

// Activation side: the planner is told to write the full plan to the draft file
// and reply with a summary, and each turn starts from a cleared file so a prior
// turn's plan can never be mistaken for the current one.

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

const VALID_PLAN_YAML = `name: "Draft Activation"
onFinish: none
tasks:
  - id: implement
    description: "Implement the change"
    prompt: "Do the work"
    dependencies: []
`;

const INLINE_PLAN_RESPONSE = `Here is the plan:

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
    // The delivery rule is hoisted to the top, before the YAML schema examples.
    const deliveryIndex = prompt.indexOf('HOW TO DELIVER THE PLAN');
    const firstSchemaIndex = prompt.indexOf('```yaml');
    expect(deliveryIndex).toBeGreaterThanOrEqual(0);
    expect(deliveryIndex).toBeLessThan(firstSchemaIndex);
    expect(prompt).toContain('NEVER paste the YAML plan into your chat reply');
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

  it('exposes the latest draft for the submit handler without marking it submitted', async () => {
    const conversation = new PlanConversation({ workingDir, threadTs: 'submit-123', plannerRetryLimit: 0 });
    const path = conversation.planDraftFilePath();
    if (!path) throw new Error('expected a plan draft path');

    mockSpawn.mockReturnValueOnce(fakePlannerChild(
      'Drafted the plan.\n\nReply `submit` to submit it.',
      () => writeFileSync(path, VALID_PLAN_YAML, 'utf8'),
    ));
    await conversation.sendMessage('Create the plan');

    expect(isConfirmation('submit')).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(conversation.planSubmitted).toBe(false);
    expect(conversation.submittedPlanText).toBeNull();

    const draftedPlan = conversation.getDraftedPlan();
    expect(draftedPlan).not.toBeNull();
    const parsedDraft = parseYaml(draftedPlan!) as Record<string, unknown>;
    expect(parsedDraft.name).toBe('Draft Activation');
  });

  it('falls back to the latest inline plan when no draft file path exists', async () => {
    const conversation = new PlanConversation({ plannerRetryLimit: 0 });

    mockSpawn.mockReturnValueOnce(fakePlannerChild(INLINE_PLAN_RESPONSE));
    await conversation.sendMessage('Create the plan');

    const draftedPlan = conversation.getDraftedPlan();
    expect(draftedPlan).not.toBeNull();
    const parsedDraft = parseYaml(draftedPlan!) as Record<string, unknown>;
    expect(parsedDraft.name).toBe('Draft Activation');
  });
});
