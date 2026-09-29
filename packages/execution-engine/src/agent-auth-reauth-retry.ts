import type { AgentAuthFailureKind } from './agent-auth-failure.js';

export type AgentAuthReauthRetryDecision =
  | { readonly action: 'retry' }
  | { readonly action: 'skip'; readonly reason: 'same-email-usage-limit' | 'missing-email' };

export function decideAgentAuthReauthRetry(input: {
  kind: AgentAuthFailureKind;
  failedEmail?: string;
  installedEmail?: string;
}): AgentAuthReauthRetryDecision {
  if (input.kind === 'login-failed') {
    return { action: 'retry' };
  }
  const failed = input.failedEmail?.trim().toLowerCase();
  const installed = input.installedEmail?.trim().toLowerCase();
  if (!failed || !installed) {
    return { action: 'skip', reason: 'missing-email' };
  }
  if (failed === installed) {
    return { action: 'skip', reason: 'same-email-usage-limit' };
  }
  return { action: 'retry' };
}
