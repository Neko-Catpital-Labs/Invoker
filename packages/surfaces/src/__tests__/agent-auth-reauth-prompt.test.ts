import { describe, expect, it } from 'vitest';

import { buildAgentAuthReauthPrompt } from '../slack/agent-auth-reauth-prompt.js';

describe('buildAgentAuthReauthPrompt', () => {
  it('names the default email and usage-limit guidance', () => {
    const prompt = buildAgentAuthReauthPrompt({
      host: 'DO1',
      agent: 'claude',
      kind: 'usage-limit',
      email: 'chanedbert@gmail.com',
    });
    expect(prompt.text).toContain('chanedbert@gmail.com');
    expect(prompt.text).toContain('will not restore quota');
    expect(prompt.text).toContain('reauth');
    expect(prompt.metadata?.event_payload).toEqual({ host: 'DO1', agent: 'claude' });
  });

  it('asks for a fresh login on authentication failure', () => {
    const prompt = buildAgentAuthReauthPrompt({
      host: 'DO1',
      agent: 'codex',
      kind: 'login-failed',
      email: 'edbertchantech@gmail.com',
    });
    expect(prompt.text).toContain('edbertchantech@gmail.com');
    expect(prompt.text).toContain('Sign in again as that email');
    expect(prompt.text).not.toContain('will not restore quota');
  });
});
