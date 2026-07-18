import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanConversation } from '../slack/plan-conversation.js';

const COMPLETE_PLAN = [
  'name: "File plan"',
  'onFinish: none',
  'tasks:',
  '  - id: first',
  '    description: First task',
  '    command: echo first',
  '    dependencies: []',
].join('\n');

const INLINE_REPLY = [
  'Here is the plan.',
  '',
  '```yaml',
  COMPLETE_PLAN.replace('File plan', 'Inline plan'),
  '```',
].join('\n');

describe('plan draft file read side', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'plan-draft-'));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  function conversationWith(threadTs: string | undefined): PlanConversation {
    return new PlanConversation({ workingDir, threadTs });
  }

  it('resolves a plan draft path under .invoker when workingDir and threadTs are set', () => {
    const conversation = conversationWith('abc-123');
    expect(conversation.planDraftFilePath()).toBe(
      join(workingDir, '.invoker', 'plan-drafts', 'abc-123.yaml'),
    );
  });

  it('sanitizes threadTs for the draft filename', () => {
    const conversation = conversationWith('thread/with:unsafe chars');
    expect(conversation.planDraftFilePath()).toBe(
      join(workingDir, '.invoker', 'plan-drafts', 'thread_with_unsafe_chars.yaml'),
    );
  });

  it('has no plan draft path without a threadTs', () => {
    expect(conversationWith(undefined).planDraftFilePath()).toBeNull();
  });

  it('prefers the drafted plan from the file when the planner wrote one', () => {
    const conversation = conversationWith('abc-123');
    const path = conversation.planDraftFilePath();
    if (!path) throw new Error('expected a plan draft path');
    mkdirSync(join(workingDir, '.invoker', 'plan-drafts'), { recursive: true });
    writeFileSync(path, COMPLETE_PLAN, 'utf8');
    (conversation as unknown as { messages: Array<{ role: string; content: string }> })
      .messages.push({ role: 'assistant', content: INLINE_REPLY });

    expect(conversation.getDraftedPlan()).toBe(COMPLETE_PLAN);
  });

  it('falls back to inline extraction when no plan file exists', () => {
    const conversation = conversationWith('abc-123');
    (conversation as unknown as { messages: Array<{ role: string; content: string }> })
      .messages.push({ role: 'assistant', content: INLINE_REPLY });

    const drafted = conversation.getDraftedPlan();
    expect(drafted).not.toBeNull();
    expect(drafted).toContain('Inline plan');
    expect(drafted).toContain('id: first');
  });
});
