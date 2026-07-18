import { describe, expect, it } from 'vitest';
import {
  resolveHeadlessExecCommand,
  resolveMutationFailureTaskId,
  summarizeMutationFailureMessage,
  summarizeMutationFailureText,
} from '../mutation-failure-message.js';

describe('resolveMutationFailureTaskId', () => {
  it('extracts task id from headless.exec fix payload', () => {
    expect(resolveMutationFailureTaskId('headless.exec', [{
      args: ['fix', 'wf-1/task-alpha', 'codex'],
      noTrack: true,
    }])).toBe('wf-1/task-alpha');
  });

  it('extracts task id from invoker:approve args', () => {
    expect(resolveMutationFailureTaskId('invoker:approve', ['wf-1/task-alpha'])).toBe('wf-1/task-alpha');
  });
});

describe('summarizeMutationFailureMessage', () => {
  it('uses error.message only and strips stack traces', () => {
    const err = new Error('SSH remote script failed (exit=1)\nSTDOUT:\n{"type":"error"}');
    err.stack = `${err.message}\n    at createSshRemoteScriptError (/tmp/main.js:1:1)`;
    expect(summarizeMutationFailureMessage(err)).not.toContain('createSshRemoteScriptError');
    expect(summarizeMutationFailureMessage(err)).toContain('SSH remote script failed');
  });

  it('prefers legible nested agent errors over raw stdout', () => {
    const text = summarizeMutationFailureText(`SSH remote script failed (exit=1, phase=remote_agent_fix)
STDOUT:
{"type":"error","message":"{\\"error\\":{\\"message\\":\\"Model unavailable\\"}}"}`);
    expect(text).toBe('Model unavailable');
  });
});

describe('resolveHeadlessExecCommand', () => {
  it('returns the CLI subcommand from headless.exec payload', () => {
    expect(resolveHeadlessExecCommand([{ args: ['fix', 'wf-1/task-alpha'] }])).toBe('fix');
  });
});
