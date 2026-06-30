import { describe, it, expect } from 'vitest';
import { parseLobbyControl } from '../slack/lobby-control.js';

describe('parseLobbyControl', () => {
  it('parses submit (with optional "to invoker" and trailing punctuation)', () => {
    expect(parseLobbyControl('submit')).toEqual({ kind: 'submit' });
    expect(parseLobbyControl('submit to invoker')).toEqual({ kind: 'submit' });
    expect(parseLobbyControl('  Submit!  ')).toEqual({ kind: 'submit' });
  });

  it('parses the restart verb (with optional target words and trailing punctuation)', () => {
    expect(parseLobbyControl('restart')).toEqual({ kind: 'restart' });
    expect(parseLobbyControl('restart invoker')).toEqual({ kind: 'restart' });
    expect(parseLobbyControl('  Restart!  ')).toEqual({ kind: 'restart' });
    expect(parseLobbyControl('restart the app')).toEqual({ kind: 'restart' });
    // Prose that merely starts with "restart" is not the verb.
    expect(parseLobbyControl('restart the login workflow')).toBeNull();
  });

  it('parses bulk ops via "all" and "all workflows"', () => {
    expect(parseLobbyControl('recreate all')).toEqual({ kind: 'op', operation: 'recreate', target: { all: true } });
    expect(parseLobbyControl('recreate all workflows')).toEqual({ kind: 'op', operation: 'recreate', target: { all: true } });
    expect(parseLobbyControl('cancel ALL')).toEqual({ kind: 'op', operation: 'cancel', target: { all: true } });
  });

  it('maps rebase aliases to canonical operations', () => {
    expect(parseLobbyControl('rebase all')).toEqual({ kind: 'op', operation: 'rebase-recreate', target: { all: true } });
    expect(parseLobbyControl('rebase-retry wf-1')).toEqual({ kind: 'op', operation: 'rebase-retry', target: { workflow: 'wf-1' } });
    expect(parseLobbyControl('rebase-recreate all')).toEqual({ kind: 'op', operation: 'rebase-recreate', target: { all: true } });
  });

  it('parses single-workflow targets', () => {
    expect(parseLobbyControl('retry wf-123')).toEqual({ kind: 'op', operation: 'retry', target: { workflow: 'wf-123' } });
    expect(parseLobbyControl('status my-flow')).toEqual({ kind: 'op', operation: 'status', target: { workflow: 'my-flow' } });
  });

  it('parses gate-policy updates with explicit downstream and upstream workflows', () => {
    expect(parseLobbyControl('gate-policy wf-child wf-parent review_ready')).toEqual({
      kind: 'gate-policy',
      target: { workflow: 'wf-child' },
      updates: [{ workflowId: 'wf-parent', gatePolicy: 'review_ready' }],
    });
    expect(parseLobbyControl('set gate policy wf-child wf-parent completed')).toEqual({
      kind: 'gate-policy',
      target: { workflow: 'wf-child' },
      updates: [{ workflowId: 'wf-parent', gatePolicy: 'completed' }],
    });
  });

  it('parses gate-policy updates with an upstream task gate', () => {
    expect(parseLobbyControl('gate-policy wf-child wf-parent/api review ready')).toEqual({
      kind: 'gate-policy',
      target: { workflow: 'wf-child' },
      updates: [{ workflowId: 'wf-parent', taskId: 'api', gatePolicy: 'review_ready' }],
    });
    expect(parseLobbyControl('gate-policy wf-child wf-parent api completed')).toEqual({
      kind: 'gate-policy',
      target: { workflow: 'wf-child' },
      updates: [{ workflowId: 'wf-parent', taskId: 'api', gatePolicy: 'completed' }],
    });
  });

  it('defaults bare status to all; a bare mutation verb is ambiguous (null)', () => {
    expect(parseLobbyControl('status')).toEqual({ kind: 'op', operation: 'status', target: { all: true } });
    expect(parseLobbyControl('recreate')).toBeNull();
    expect(parseLobbyControl('cancel')).toBeNull();
  });

  it('returns null for prose and non-commands (routes to conversation/classifier)', () => {
    expect(parseLobbyControl('recreate the login flow as a plan')).toBeNull();
    expect(parseLobbyControl('how many workflows are running?')).toBeNull();
    expect(parseLobbyControl('add a /health endpoint')).toBeNull();
    expect(parseLobbyControl('recreate + rebase all workflows')).toBeNull();
    expect(parseLobbyControl('gate-policy wf-child review_ready')).toBeNull();
    expect(parseLobbyControl('gate-policy wf-child wf-parent api extra completed')).toBeNull();
    expect(parseLobbyControl('')).toBeNull();
  });
});
