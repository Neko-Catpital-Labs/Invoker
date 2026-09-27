import { FailureClassifier } from '@invoker/workflow-core';

import {
  LOGIN_FAILURE_SIGNATURES,
  type AgentLoginAgent,
} from './workers/agent-login-watch-worker.js';

export type AgentAuthFailureKind = 'usage-limit' | 'login-failed';

export interface AgentAuthFailure {
  readonly kind: AgentAuthFailureKind;
  readonly agent: AgentLoginAgent;
}

function isAgentLoginAgent(value: string | undefined): value is AgentLoginAgent {
  return value === 'claude' || value === 'codex';
}

function textLooksLikeLoginFailure(text: string): boolean {
  const lower = text.toLowerCase();
  return LOGIN_FAILURE_SIGNATURES.some((signature) => lower.includes(signature));
}

export function classifyAgentAuthFailure(
  text: string | undefined,
  agentHint?: string,
): AgentAuthFailure | undefined {
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  const agent = isAgentLoginAgent(agentHint) ? agentHint : undefined;
  if (!agent) return undefined;

  if (FailureClassifier.classifyAgentQuotaRefusal(text) === 'agent-usage-limit') {
    return { kind: 'usage-limit', agent };
  }
  if (
    FailureClassifier.classifyError(text) === 'ssh-oauth-session-expired'
    || textLooksLikeLoginFailure(text)
  ) {
    return { kind: 'login-failed', agent };
  }
  return undefined;
}
