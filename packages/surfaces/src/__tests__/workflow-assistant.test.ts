import { describe, it, expect } from 'vitest';
import { buildAssistantPrompt, parseWorkflowControl } from '../slack/workflow-assistant.js';
import type { WorkflowContext } from '../slack/workflow-assistant.js';

describe('parseWorkflowControl', () => {
  it('parses status', () => {
    expect(parseWorkflowControl('status')).toEqual({ kind: 'status' });
    expect(parseWorkflowControl('  STATUS please ')).toEqual({ kind: 'status' });
  });

  it('parses approve/reject/retry with a task id', () => {
    expect(parseWorkflowControl('approve api')).toEqual({ kind: 'approve', task: 'api' });
    expect(parseWorkflowControl('reject db')).toEqual({ kind: 'reject', task: 'db' });
    expect(parseWorkflowControl('retry web')).toEqual({ kind: 'retry', task: 'web' });
  });

  it('parses input with a task id and trailing text', () => {
    expect(parseWorkflowControl('input api: use port 8080')).toEqual({
      kind: 'input',
      task: 'api',
      text: 'use port 8080',
    });
  });

  it('returns null for free-form questions', () => {
    expect(parseWorkflowControl('what did the api task change?')).toBeNull();
    expect(parseWorkflowControl('approve')).toBeNull(); // verb without a task id
  });
});

describe('buildAssistantPrompt', () => {
  const ctx: WorkflowContext = {
    workflowId: 'wf-1-2',
    planning: [{ role: 'user', content: 'add a health endpoint' }],
    tasks: [
      { id: 'wf-1-2/api', status: 'completed', agentName: 'omp', transcript: [{ role: 'assistant', content: 'added /health' }], output: 'done' },
    ],
  };

  it('embeds the workflow id, planning, transcripts, and the question', () => {
    const prompt = buildAssistantPrompt('what changed?', ctx);
    expect(prompt).toContain('wf-1-2');
    expect(prompt).toContain('add a health endpoint');
    expect(prompt).toContain('Task wf-1-2/api');
    expect(prompt).toContain('added /health');
    expect(prompt).toContain('what changed?');
    expect(prompt).toContain('Answer ONLY from');
  });

  it('asks workflow question answers to be short ELI5 Slack prose except for clearly technical questions', () => {
    const prompt = buildAssistantPrompt('what changed?', ctx);
    expect(prompt).toContain('ELI5 Slack prose');
    expect(prompt).toContain('40 words or fewer');
    expect(prompt).toContain('clearly technical');
  });
});
