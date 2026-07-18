import { describe, expect, it } from 'vitest';
import {
  extractLegibleAgentFailure,
  formatRemoteAgentFailureForTask,
} from '../remote-agent-error-format.js';

const nestedAgentError = JSON.stringify({
  type: 'error',
  status: 400,
  error: {
    type: 'invalid_request_error',
    message: "The 'claude' model is not supported when using Codex with a ChatGPT account.",
  },
});

const SSH_FIX_FAILURE = `SSH remote script failed (exit=1, phase=remote_agent_fix)
STDERR:
Reading additional input from stdin...
STDOUT:
{"type":"thread.started","thread_id":"019f45d7-61f0-74a1-a604-7b2aa94a9d1f"}
{"type":"turn.started"}
${JSON.stringify({ type: 'error', message: nestedAgentError })}
${JSON.stringify({ type: 'turn.failed', error: { message: nestedAgentError } })}`;

describe('extractLegibleAgentFailure', () => {
  it('extracts nested JSON error messages from SSH stdout JSONL', () => {
    expect(extractLegibleAgentFailure(SSH_FIX_FAILURE)).toBe(
      "The 'claude' model is not supported when using Codex with a ChatGPT account.",
    );
  });

  it('returns undefined when no agent error is present', () => {
    expect(extractLegibleAgentFailure('plain command failed')).toBeUndefined();
  });
});

describe('formatRemoteAgentFailureForTask', () => {
  it('keeps SSH header and replaces JSONL dump with legible agent error', () => {
    const formatted = formatRemoteAgentFailureForTask(SSH_FIX_FAILURE);
    expect(formatted).toContain('SSH remote script failed (exit=1, phase=remote_agent_fix)');
    expect(formatted).toContain("The 'claude' model is not supported when using Codex with a ChatGPT account.");
    expect(formatted).not.toContain('thread.started');
  });

  it('strips stack traces from the stored task error', () => {
    const withStack = `${SSH_FIX_FAILURE}\n    at createSshRemoteScriptError (/tmp/main.js:1:1)`;
    const formatted = formatRemoteAgentFailureForTask(withStack);
    expect(formatted).not.toContain('createSshRemoteScriptError');
  });
});
