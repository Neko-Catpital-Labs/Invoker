import { describe, expect, it } from 'vitest';

import { classifyAgentAuthFailure } from '../agent-auth-failure.js';
import { decideAgentAuthReauthRetry } from '../agent-auth-reauth-retry.js';

describe('classifyAgentAuthFailure', () => {
  it('classifies a Claude usage-limit line', () => {
    expect(
      classifyAgentAuthFailure(
        'Error: Claude AI usage limit reached. Your limit will reset at 2026-10-01.',
        'claude',
      ),
    ).toEqual({ kind: 'usage-limit', agent: 'claude' });
  });

  it('classifies an OAuth-expired login failure for Codex', () => {
    expect(
      classifyAgentAuthFailure(
        'failed to authenticate: oauth session expired and could not be refreshed',
        'codex',
      ),
    ).toEqual({ kind: 'login-failed', agent: 'codex' });
  });

  it('matches token_invalidated on a boundary and ignores a longer token', () => {
    expect(classifyAgentAuthFailure('{"error":"token_invalidated"}', 'codex')).toEqual({
      kind: 'login-failed',
      agent: 'codex',
    });
    expect(classifyAgentAuthFailure('token_invalidated_backup', 'codex')).toBeUndefined();
  });

  it('ignores non-auth failures and unknown agents', () => {
    expect(classifyAgentAuthFailure('ENOENT: no such file', 'claude')).toBeUndefined();
    expect(
      classifyAgentAuthFailure('Claude AI usage limit reached', 'cursor'),
    ).toBeUndefined();
  });
});

describe('decideAgentAuthReauthRetry', () => {
  it('retries login failures once after install', () => {
    expect(
      decideAgentAuthReauthRetry({
        kind: 'login-failed',
        failedEmail: 'a@example.com',
        installedEmail: 'a@example.com',
      }),
    ).toEqual({ action: 'retry' });
  });

  it('does not retry same-email usage reauth', () => {
    expect(
      decideAgentAuthReauthRetry({
        kind: 'usage-limit',
        failedEmail: 'chanedbert@gmail.com',
        installedEmail: 'chanedbert@gmail.com',
      }),
    ).toEqual({ action: 'skip', reason: 'same-email-usage-limit' });
  });

  it('retries usage-limit when installed email differs', () => {
    expect(
      decideAgentAuthReauthRetry({
        kind: 'usage-limit',
        failedEmail: 'old@example.com',
        installedEmail: 'new@example.com',
      }),
    ).toEqual({ action: 'retry' });
  });
});
