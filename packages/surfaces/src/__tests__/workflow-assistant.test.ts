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

  it('parses gate-policy updates for the current workflow channel', () => {
    expect(parseWorkflowControl('gate-policy wf-parent review_ready')).toEqual({
      kind: 'gate-policy',
      updates: [{ workflowId: 'wf-parent', gatePolicy: 'review_ready' }],
    });
    expect(parseWorkflowControl('set gate policy wf-parent completed')).toEqual({
      kind: 'gate-policy',
      updates: [{ workflowId: 'wf-parent', gatePolicy: 'completed' }],
    });
  });

  it('parses gate-policy updates with an upstream task gate', () => {
    expect(parseWorkflowControl('gate-policy wf-parent/api review ready')).toEqual({
      kind: 'gate-policy',
      updates: [{ workflowId: 'wf-parent', taskId: 'api', gatePolicy: 'review_ready' }],
    });
    expect(parseWorkflowControl('gate-policy wf-parent api completed')).toEqual({
      kind: 'gate-policy',
      updates: [{ workflowId: 'wf-parent', taskId: 'api', gatePolicy: 'completed' }],
    });
  });

  it('returns null for free-form questions', () => {
    expect(parseWorkflowControl('what did the api task change?')).toBeNull();
    expect(parseWorkflowControl('approve')).toBeNull(); // verb without a task id
    expect(parseWorkflowControl('gate-policy review_ready')).toBeNull();
    expect(parseWorkflowControl('gate-policy wf-parent api extra completed')).toBeNull();
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
});
