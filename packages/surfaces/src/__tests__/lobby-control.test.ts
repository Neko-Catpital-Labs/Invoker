import { describe, it, expect } from 'vitest';
import { parseLobbyControl } from '../slack/lobby-control.js';

describe('parseLobbyControl', () => {
  it('parses submit (with optional "to invoker" and trailing punctuation)', () => {
    expect(parseLobbyControl('submit')).toEqual({ kind: 'submit' });
    expect(parseLobbyControl('submit to invoker')).toEqual({ kind: 'submit' });
    expect(parseLobbyControl('  Submit!  ')).toEqual({ kind: 'submit' });
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
    expect(parseLobbyControl('')).toBeNull();
  });
});
