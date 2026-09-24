import { describe, expect, it } from 'vitest';
import { FailureClassifier } from '../failure-classifier.js';

describe('FailureClassifier.classifyAgentQuotaRefusal Claude session limit', () => {
  it('classifies the remote fix session-limit refusal as agent-usage-limit', () => {
    const output = "[Fix with Agent failed] SSH remote script failed (exit=1, phase=remote_agent_fix)\nSTDOUT:\nYou've hit your session limit · resets 2:50am (UTC)";
    expect(FailureClassifier.classifyAgentQuotaRefusal(output)).toBe('agent-usage-limit');
  });

  it('classifies the local claude fix session-limit refusal as agent-usage-limit', () => {
    const output = "claude fix exited with code 1: You've hit your session limit · resets 10:50am (Asia/Hong_Kong)";
    expect(FailureClassifier.classifyAgentQuotaRefusal(output)).toBe('agent-usage-limit');
  });

  it('does not classify unrelated session text', () => {
    expect(FailureClassifier.classifyAgentQuotaRefusal('AssertionError: expected session to be closed')).toBeUndefined();
  });

  it('ignores CI check-list rows that mention the session limit', () => {
    expect(FailureClassifier.classifyAgentQuotaRefusal('ci / check\tfail\t2m\thit your session limit')).toBeUndefined();
  });
});
