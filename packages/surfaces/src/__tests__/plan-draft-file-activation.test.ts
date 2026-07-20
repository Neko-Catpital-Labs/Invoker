import { describe, expect, it, vi } from 'vitest';
import { PlanConversation, buildPlanSystemPrompt } from '../slack/plan-conversation.js';
import * as child_process from 'node:child_process';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof child_process>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const mockSpawn = vi.mocked(child_process.spawn);

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

describe('plan draft activation prompt policy', () => {
  it('keeps the YAML schema available to default direct-draft callers', () => {
    const prompt = buildPlanSystemPrompt('main');
    expect(prompt).toContain('A plan has this structure');
    expect(prompt).toContain('```yaml');
    expect(prompt).toContain('After generating a plan, tell the user they can confirm execution');
  });

  it('hides YAML schema and draft-file mechanics before conversational draft approval', () => {
    const prompt = buildPlanSystemPrompt('main', undefined, { conversationalPlanning: true });
    expect(prompt).toContain('planning conversation before a plan');
    expect(prompt).toContain('Do NOT generate a YAML plan, YAML schema, draft file, or executable task list yet');
    expect(prompt).not.toContain('A plan has this structure');
    expect(prompt).not.toContain('```yaml');
  });

  it('restores YAML drafting mechanics after conversational draft approval', () => {
    const prompt = buildPlanSystemPrompt('main', undefined, {
      conversationalPlanning: true,
      draftAuthorized: true,
    });
    expect(prompt).toContain('explicitly authorized drafting');
    expect(prompt).toContain('A plan has this structure');
    expect(prompt).toContain('```yaml');
  });

  it('passes approved conversational drafting prompts to the agent instead of treating yes as failed execution', async () => {
    mockSpawn.mockReset();
    mockSpawn.mockReturnValueOnce(createMockProcess('Drafting now.'));
    const conversation = new PlanConversation({ conversationalPlanning: true });

    const reply = await conversation.sendMessage('yes');

    expect(reply).toBe('Drafting now.');
    expect(conversation.planSubmitted).toBe(false);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const prompt = mockSpawn.mock.calls[0][1][1] as string;
    expect(prompt).toContain('explicitly authorized drafting');
    expect(prompt).toContain('A plan has this structure');
  });
});
