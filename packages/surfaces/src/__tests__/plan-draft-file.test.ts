import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanConversation } from '../slack/plan-conversation.js';

// A large plan can truncate when the model emits it inline, because the reply
// then has to carry the whole YAML. The planner instead writes the plan to a
// file and replies with a short summary. This suite covers the read side: the
// conversation prefers the file when it exists, and falls back to inline
// extraction from the chat history when it does not.

const COMPLETE_PLAN = [
  'name: "File plan"',
  'onFinish: none',
  'tasks:',
  '  - id: first',
  '    description: First task',
  '    command: echo first',
].join('\n');

const INLINE_REPLY = [
  'Here is the plan.',
  '',
  '```yaml',
  COMPLETE_PLAN,
  '```',
].join('\n');

describe('plan draft file — read side', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'plan-draft-'));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  function conversationWith(threadTs: string | undefined): PlanConversation {
    return new PlanConversation({ workingDir, threadTs, plannerRetryLimit: 0 });
  }

  it('resolves a plan draft path under .invoker when workingDir and threadTs are set', () => {
    const conversation = conversationWith('abc-123');
    expect(conversation.planDraftFilePath()).toBe(
      join(workingDir, '.invoker', 'plan-drafts', 'abc-123.yaml'),
    );
  });

  it('has no plan draft path without a threadTs', () => {
    expect(conversationWith(undefined).planDraftFilePath()).toBeNull();
  });

  it('reads the drafted plan from the file when the planner wrote one', () => {
    const conversation = conversationWith('abc-123');
    const path = conversation.planDraftFilePath();
    if (!path) throw new Error('expected a plan draft path');
    mkdirSync(join(workingDir, '.invoker', 'plan-drafts'), { recursive: true });
    writeFileSync(path, COMPLETE_PLAN, 'utf8');

    expect(conversation.getDraftedPlan()).toBe(COMPLETE_PLAN);
  });

  it('falls back to inline extraction when no plan file exists', () => {
    const conversation = conversationWith('abc-123');
    // Simulate a turn whose reply carried an inline ```yaml block.
    (conversation as unknown as { messages: Array<{ role: string; content: string }> })
      .messages.push({ role: 'assistant', content: INLINE_REPLY });

    const drafted = conversation.getDraftedPlan();
    expect(drafted).not.toBeNull();
    expect(drafted).toContain('File plan');
    expect(drafted).toContain('id: first');
  });
});
