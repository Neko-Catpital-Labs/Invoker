import type {
  AgentLoginProvider,
  AgentLoginSessionDependencies,
  AgentLoginSessionStatus,
  AgentLoginSessionStatusView,
} from './agent-login-session.js';

export type HeadlessCommandKind = 'read' | 'write' | 'special';

export interface HeadlessCommandDefinition {
  readonly name: string;
  readonly kind: HeadlessCommandKind;
}

export {
  HEADLESS_SET_SUBCOMMANDS,
  findHeadlessSetSubcommandScope,
  formatHeadlessSetSubcommands,
  type HeadlessSetSubcommand,
  type HeadlessSetSubcommandDefinition,
  type HeadlessSetSubcommandScope,
} from '@invoker/contracts';

export const HEADLESS_COMMANDS = [
  { name: 'owner-serve', kind: 'special' },
  { name: 'query', kind: 'read' },
  { name: 'set', kind: 'special' },
  { name: 'migrate-compat', kind: 'write' },
  { name: 'repair-filing', kind: 'write' },
  { name: 'install-skills', kind: 'special' },
  { name: 'watch', kind: 'read' },
  { name: 'run', kind: 'write' },
  { name: 'start-ready', kind: 'write' },
  { name: 'resume', kind: 'write' },
  { name: 'retry', kind: 'write' },
  { name: 'retry-task', kind: 'write' },
  { name: 'recreate', kind: 'write' },
  { name: 'recreate-task', kind: 'write' },
  { name: 'recreate-downstream', kind: 'write' },
  { name: 'replace-task', kind: 'special' },
  { name: 'fork-workflow', kind: 'write' },
  { name: 'detach-workflow', kind: 'write' },
  { name: 'attach-workflow', kind: 'write' },
  { name: 'rebase-retry', kind: 'write' },
  { name: 'rebase-recreate', kind: 'write' },
  { name: 'repair-review-gate-ci', kind: 'write' },
  { name: 'check-pr-status', kind: 'write' },
  { name: 'fix', kind: 'write' },
  { name: 'resolve-conflict', kind: 'write' },
  { name: 'approve', kind: 'write' },
  { name: 'reject', kind: 'write' },
  { name: 'input', kind: 'write' },
  { name: 'select', kind: 'write' },
  { name: 'cancel', kind: 'write' },
  { name: 'cancel-workflow', kind: 'write' },
  { name: 'delete-task', kind: 'write' },
  { name: 'close-task', kind: 'write' },
  { name: 'delete', kind: 'write' },
  { name: 'delete-all', kind: 'write' },
  { name: 'reset-autofix-budget', kind: 'write' },
  { name: 'open-terminal', kind: 'read' },
  { name: 'query-select', kind: 'read' },
  { name: 'agent-login', kind: 'write' },
  { name: 'worker', kind: 'read' },
] as const satisfies readonly HeadlessCommandDefinition[];

export function findHeadlessCommandDefinition(command: string | undefined): HeadlessCommandDefinition | undefined {
  if (!command) return undefined;
  return HEADLESS_COMMANDS.find((definition) => definition.name === command);
}

export function isHeadlessHelpCommand(command: string | undefined): boolean {
  return command === undefined || command === '--help' || command === '-h';
}

export function isRemovedHeadlessCommandAlias(command: string | undefined): boolean {
  return command === 'set-merge-mode';
}

export function isMutatingSetSubcommand(subcommand: string | undefined): boolean {
  return typeof subcommand === 'string' && subcommand.length > 0;
}

export const AGENT_LOGIN_SUBCOMMANDS = ['start', 'code', 'status'] as const;

export type AgentLoginSubcommand = (typeof AGENT_LOGIN_SUBCOMMANDS)[number];

export const AGENT_LOGIN_PROVIDERS = ['claude', 'codex'] as const;

export type AgentLoginOutputFormat = 'text' | 'json';

export interface AgentLoginCommandResult {
  readonly sessionId: string;
  readonly provider: AgentLoginProvider;
  readonly status: AgentLoginSessionStatus;
  readonly url?: string;
  readonly userCode?: string;
  readonly message: string;
}

export type AgentLoginCommandRequest =
  | { subcommand: 'start'; provider: AgentLoginProvider; output: AgentLoginOutputFormat; host?: string }
  | { subcommand: 'code'; sessionId: string; code: string; output: AgentLoginOutputFormat }
  | { subcommand: 'status'; sessionId: string; output: AgentLoginOutputFormat };

export interface AgentLoginSessionModule {
  startAgentLogin(
    provider: AgentLoginProvider,
    deps?: AgentLoginSessionDependencies,
    host?: string,
  ): Promise<AgentLoginSessionStatusView>;
  submitAgentLoginCode(
    sessionId: string,
    code: string,
    deps?: AgentLoginSessionDependencies,
  ): Promise<AgentLoginSessionStatusView>;
  getAgentLoginStatus(
    sessionId: string,
    deps?: AgentLoginSessionDependencies,
  ): AgentLoginSessionStatusView;
}

export class AgentLoginCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentLoginCommandError';
  }
}

export function formatAgentLoginSubcommands(): string {
  return AGENT_LOGIN_SUBCOMMANDS.join('|');
}

function parseAgentLoginOutput(args: string[]): AgentLoginOutputFormat {
  const index = args.indexOf('--output');
  if (index === -1) return 'text';
  const value = args[index + 1];
  if (value !== 'text' && value !== 'json') {
    throw new AgentLoginCommandError(
      `Invalid --output format: "${value ?? ''}". Must be text|json.`,
    );
  }
  return value;
}

function parseAgentLoginHost(args: string[]): string | undefined {
  const index = args.indexOf('--host');
  if (index === -1) return undefined;
  const value = args[index + 1]?.trim();
  if (!value || value.startsWith('--')) {
    throw new AgentLoginCommandError('agent-login requires a host after --host.');
  }
  return value;
}

function agentLoginPositionalArgs(args: string[]): string[] {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--output') {
      i += 1;
      continue;
    }
    if (arg === '--host') {
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new AgentLoginCommandError(`Unknown agent-login option "${arg}".`);
    }
    positional.push(arg);
  }
  return positional;
}

function isAgentLoginSubcommand(value: string): value is AgentLoginSubcommand {
  return (AGENT_LOGIN_SUBCOMMANDS as readonly string[]).includes(value);
}

function isAgentLoginProvider(value: string): value is AgentLoginProvider {
  return (AGENT_LOGIN_PROVIDERS as readonly string[]).includes(value);
}

function requireAgentLoginArg(value: string | undefined, label: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) {
    throw new AgentLoginCommandError(`agent-login requires a ${label}.`);
  }
  return trimmed;
}

export function parseAgentLoginCommand(args: string[]): AgentLoginCommandRequest {
  const output = parseAgentLoginOutput(args);
  const host = parseAgentLoginHost(args);
  const positional = agentLoginPositionalArgs(args);
  const subcommand = positional[0];
  if (!subcommand) {
    throw new AgentLoginCommandError(
      `agent-login requires a subcommand (${formatAgentLoginSubcommands()}).`,
    );
  }
  if (!isAgentLoginSubcommand(subcommand)) {
    throw new AgentLoginCommandError(
      `Unknown agent-login subcommand "${subcommand}". Must be ${formatAgentLoginSubcommands()}.`,
    );
  }
  if (positional.length > (subcommand === 'code' ? 3 : 2)) {
    throw new AgentLoginCommandError(`agent-login ${subcommand} received too many arguments.`);
  }

  if (subcommand === 'start') {
    const provider = requireAgentLoginArg(positional[1], 'provider (claude|codex)');
    if (!isAgentLoginProvider(provider)) {
      throw new AgentLoginCommandError(
        `Unknown agent-login provider "${provider}". Must be claude|codex.`,
      );
    }
    return { subcommand, provider, output, ...(host ? { host } : {}) };
  }

  if (host) {
    throw new AgentLoginCommandError('Unknown agent-login option "--host".');
  }

  const sessionId = requireAgentLoginArg(positional[1], 'session id');
  if (subcommand === 'status') {
    return { subcommand, sessionId, output };
  }
  const code = requireAgentLoginArg(positional[2], 'login code');
  return { subcommand, sessionId, code, output };
}

function agentLoginMessage(view: AgentLoginSessionStatusView): string {
  switch (view.status) {
    case 'starting':
      return `Starting ${view.provider} login.`;
    case 'awaiting_user':
      return `Open ${view.loginUrl ?? 'the login URL'} and approve the ${view.provider} login.`;
    case 'awaiting_code':
      return `Open ${view.loginUrl ?? 'the login URL'}, then send the code back with "agent-login code ${view.sessionId} <code>".`;
    case 'verifying':
      return `Verifying the new ${view.provider} login before installing it.`;
    case 'installed':
      return `The new ${view.provider} login passed its test call and is installed.`;
    case 'failed':
      return `The ${view.provider} login failed: ${view.error ?? 'unknown error'}. The live login was left untouched.`;
  }
}

export function toAgentLoginCommandResult(view: AgentLoginSessionStatusView): AgentLoginCommandResult {
  const result: AgentLoginCommandResult = {
    sessionId: view.sessionId,
    provider: view.provider,
    status: view.status,
    message: agentLoginMessage(view),
  };
  return {
    ...result,
    ...(view.loginUrl ? { url: view.loginUrl } : {}),
    ...(view.code ? { userCode: view.code } : {}),
  };
}

export function formatAgentLoginCommandResult(
  result: AgentLoginCommandResult,
  output: AgentLoginOutputFormat,
): string {
  if (output === 'json') return JSON.stringify(result);
  const lines = [`session ${result.sessionId} (${result.provider}): ${result.status}`];
  if (result.url) lines.push(`url: ${result.url}`);
  if (result.userCode) lines.push(`code: ${result.userCode}`);
  lines.push(result.message);
  return lines.join('\n');
}

async function loadAgentLoginSessionModule(): Promise<AgentLoginSessionModule> {
  return await import('./agent-login-session.js');
}

function rejectAgentLoginCode(sessionId: string, status: AgentLoginSessionStatus): never {
  throw new AgentLoginCommandError(
    `Agent login session "${sessionId}" is not awaiting a code (status: ${status}).`,
  );
}

export async function runAgentLoginCommand(
  args: string[],
  sessionModule?: AgentLoginSessionModule,
  startDeps?: AgentLoginSessionDependencies,
): Promise<AgentLoginCommandResult> {
  const request = parseAgentLoginCommand(args);
  const loginSessions = sessionModule ?? (await loadAgentLoginSessionModule());

  if (request.subcommand === 'start') {
    const started = request.host
      ? await loginSessions.startAgentLogin(request.provider, startDeps, request.host)
      : await loginSessions.startAgentLogin(request.provider);
    return toAgentLoginCommandResult(started);
  }

  let current: AgentLoginSessionStatusView;
  try {
    current = loginSessions.getAgentLoginStatus(request.sessionId);
  } catch (error) {
    throw new AgentLoginCommandError(error instanceof Error ? error.message : String(error));
  }

  if (request.subcommand === 'status') {
    return toAgentLoginCommandResult(current);
  }

  if (current.status === 'failed' || current.status === 'installed') {
    rejectAgentLoginCode(request.sessionId, current.status);
  }

  try {
    return toAgentLoginCommandResult(
      await loginSessions.submitAgentLoginCode(request.sessionId, request.code),
    );
  } catch (error) {
    throw new AgentLoginCommandError(error instanceof Error ? error.message : String(error));
  }
}
