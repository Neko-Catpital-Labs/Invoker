import type { AgentAuthFailureKind } from '@invoker/execution-engine';

import type { AgentLoginAgent, AgentLoginTarget } from './slack-agent-login.js';
import { AGENT_LOGIN_REAUTH_HINT, buildAgentLoginAlertMetadata } from './slack-agent-login.js';
import { readAgentAccountEmail } from './agent-account-email.js';

const AGENT_LABEL: Record<AgentLoginAgent, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

export interface AgentAuthReauthPrompt {
  readonly text: string;
  readonly alertKey: string;
  readonly metadata: ReturnType<typeof buildAgentLoginAlertMetadata>;
  readonly target: AgentLoginTarget;
  readonly kind: AgentAuthFailureKind;
  readonly email?: string;
}

export function buildAgentAuthReauthPrompt(input: {
  host: string;
  agent: AgentLoginAgent;
  kind: AgentAuthFailureKind;
  email?: string;
}): AgentAuthReauthPrompt {
  const email = input.email ?? readAgentAccountEmail(input.agent);
  const label = AGENT_LABEL[input.agent];
  const accountLine = email
    ? `Default account on this host: \`${email}\`.`
    : `Default account on this host: the account already signed in for ${label}.`;
  const kindLine = input.kind === 'usage-limit'
    ? `Signing in again as that same email will not restore quota — pick another account on the provider page, or wait until the usage limit resets.`
    : `Sign in again as that email (or pick another account on the provider page).`;
  const text = [
    `The ${label} login on ${input.host} needs attention (${input.kind === 'usage-limit' ? 'usage limit' : 'authentication failure'}).`,
    accountLine,
    kindLine,
    AGENT_LOGIN_REAUTH_HINT,
  ].join('\n');
  const alertKey = `agent-login:${input.host}:${input.agent}`;
  return {
    text,
    alertKey,
    metadata: buildAgentLoginAlertMetadata(alertKey),
    target: { host: input.host, agent: input.agent },
    kind: input.kind,
    email,
  };
}
