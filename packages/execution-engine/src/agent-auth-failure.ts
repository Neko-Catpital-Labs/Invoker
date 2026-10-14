import { FailureClassifier } from '@invoker/workflow-core';

import {
  outputMatchesLoginFailure,
  type AgentLoginAgent,
} from './workers/agent-login-watch-worker.js';

export type AgentAuthFailureKind = 'usage-limit' | 'login-failed';

export interface AgentAuthFailure {
  readonly kind: AgentAuthFailureKind;
  readonly agent: AgentLoginAgent;
}

export { outputMatchesLoginFailure };

/**
 * Auth signals that often precede a hang (Cursor status limbo, Codex 401
 * reconnect loops). After a short grace with no exit, planning aborts.
 */
export const PLANNER_AUTH_LIMBO_OUTPUT_MARKERS = [
  'unable to fetch user details',
  '401 unauthorized',
  'missing bearer or basic authentication',
] as const;

const PLANNER_AUTH_FAILURE_OUTPUT_MARKERS = [
  ...PLANNER_AUTH_LIMBO_OUTPUT_MARKERS,
  'authentication required',
  'not logged in',
  'unauthorized',
  'failed to authenticate',
  'authentication failed',
  'oauth session expired',
  're-authenticate',
  'session expired',
  'cursor agent login',
  'cursor-agent login',
  'cursor_api_key',
] as const;

export const PLANNER_AUTH_LIMBO_GRACE_MS = 3_000;

function isAgentLoginAgent(value: string | undefined): value is AgentLoginAgent {
  return value === 'claude' || value === 'codex';
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
    || outputMatchesLoginFailure(text)
  ) {
    return { kind: 'login-failed', agent };
  }
  return undefined;
}

export function plannerOutputIndicatesAuthLimbo(output: string): boolean {
  const lower = output.toLowerCase();
  return PLANNER_AUTH_LIMBO_OUTPUT_MARKERS.some((marker) => lower.includes(marker));
}

export function plannerOutputIndicatesAuthFailure(output: string): boolean {
  if (outputMatchesLoginFailure(output)) return true;
  const lower = output.toLowerCase();
  return PLANNER_AUTH_FAILURE_OUTPUT_MARKERS.some((marker) => lower.includes(marker));
}

export function plannerAuthRecoveryHint(plannerLabel: string): string {
  const key = plannerLabel.toLowerCase();
  if (key.includes('cursor')) {
    return 'Run `cursor agent login` or `cursor-agent login` or set CURSOR_API_KEY, then try again.';
  }
  if (key.includes('codex')) {
    return 'Run `codex login` (or `invoker-cli agent-login` for Codex), then try again.';
  }
  if (key.includes('claude')) {
    return 'Run `claude` and complete `/login` (or `invoker-cli agent-login` for Claude), then try again.';
  }
  if (key.includes('omp')) {
    return 'Re-authenticate the OMP provider (Claude/Codex behind OMP), then try again.';
  }
  return 'Re-authenticate the selected harness, then try again.';
}

export function buildPlannerAuthRequiredMessage(plannerLabel: string): string {
  return `${plannerLabel}: Authentication required. ${plannerAuthRecoveryHint(plannerLabel)}`;
}

export function buildPlannerAuthRequiredError(plannerLabel: string): Error {
  return new Error(buildPlannerAuthRequiredMessage(plannerLabel));
}
