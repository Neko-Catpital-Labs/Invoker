export type AgentLoginAgent = 'claude' | 'codex';

export const AGENT_LOGIN_ALERT_KEY_PREFIX = 'agent-login:';
export const AGENT_LOGIN_METADATA_EVENT_TYPE = 'invoker_agent_login';

const AGENT_LABEL: Record<AgentLoginAgent, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

export interface AgentLoginTarget {
  host: string;
  agent: AgentLoginAgent;
}

export interface SlackMessageMetadata {
  event_type: string;
  event_payload: Record<string, string>;
}

export const AGENT_LOGIN_NOT_ADMIN_MESSAGE =
  'Permission denied. Only Invoker Slack admins can start an agent login or send a login code.';

export const AGENT_LOGIN_REAUTH_HINT =
  'Reply `reauth` in this thread when you want to sign it back in.';

function isAgentLoginAgent(value: string): value is AgentLoginAgent {
  return value === 'claude' || value === 'codex';
}

export function parseAgentLoginAlertKey(alertKey: string): AgentLoginTarget | null {
  if (!alertKey.startsWith(AGENT_LOGIN_ALERT_KEY_PREFIX)) return null;
  const rest = alertKey.slice(AGENT_LOGIN_ALERT_KEY_PREFIX.length);
  const split = rest.lastIndexOf(':');
  if (split <= 0) return null;
  const host = rest.slice(0, split).trim();
  const agent = rest.slice(split + 1).trim();
  if (!host || !isAgentLoginAgent(agent)) return null;
  return { host, agent };
}

export function buildAgentLoginAlertMetadata(alertKey: string): SlackMessageMetadata | undefined {
  const target = parseAgentLoginAlertKey(alertKey);
  if (!target) return undefined;
  return {
    event_type: AGENT_LOGIN_METADATA_EVENT_TYPE,
    event_payload: { host: target.host, agent: target.agent },
  };
}

export function readAgentLoginMetadata(metadata: unknown): AgentLoginTarget | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const record = metadata as { event_type?: unknown; event_payload?: unknown };
  if (record.event_type !== AGENT_LOGIN_METADATA_EVENT_TYPE) return null;
  const payload = record.event_payload;
  if (!payload || typeof payload !== 'object') return null;
  const { host, agent } = payload as { host?: unknown; agent?: unknown };
  if (typeof host !== 'string' || typeof agent !== 'string') return null;
  const trimmedHost = host.trim();
  if (!trimmedHost || !isAgentLoginAgent(agent)) return null;
  return { host: trimmedHost, agent };
}

export interface AgentLoginCommandView {
  sessionId: string;
  provider: string;
  status: string;
  url?: string;
  userCode?: string;
  message: string;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizeAgentLoginResult(raw: unknown): AgentLoginCommandView | null {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
    return normalizeAgentLoginResult(parsed);
  }
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const sessionId = optionalString(record.sessionId);
  const status = optionalString(record.status);
  if (!sessionId || !status) return null;
  return {
    sessionId,
    provider: optionalString(record.provider) ?? 'unknown',
    status,
    url: optionalString(record.url),
    userCode: optionalString(record.userCode),
    message: optionalString(record.message) ?? '',
  };
}

const TOKEN_LIKE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  /\b(?:oat|sess|ghp|gho|xoxb|xoxp)[-_][A-Za-z0-9_-]{12,}/g,
  /\b[A-Fa-f0-9]{40,}\b/g,
];

export const REDACTED_PLACEHOLDER = '[redacted]';

export function redactTokenLike(text: string): string {
  let result = text;
  for (const pattern of TOKEN_LIKE_PATTERNS) {
    result = result.replace(pattern, REDACTED_PLACEHOLDER);
  }
  return result;
}

export interface AgentLoginThreadDeps {
  isAdmin(userId: string | undefined): boolean;
  resolveTarget(channel: string, threadTs: string): Promise<AgentLoginTarget | null>;
  runHeadlessCommand(args: string[]): Promise<unknown>;
  post(text: string, threadTs: string, channel: string): Promise<void>;
  log?(level: 'info' | 'warn' | 'error', message: string): void;
}

export interface AgentLoginThreadReply {
  channel: string;
  threadTs: string;
  userId?: string;
  text: string;
}

interface AgentLoginThreadSession {
  sessionId: string;
  target: AgentLoginTarget;
  awaitingCode: boolean;
}

const CODE_TOKEN = /^[\w.:#@/+=-]{4,256}$/;

const COMMAND_FAILED = Symbol('agent-login-command-failed');

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function describeUnreadable(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw) ?? String(raw);
  return redactTokenLike(text.slice(0, 200));
}

function label(target: AgentLoginTarget): string {
  return AGENT_LABEL[target.agent];
}

export function formatAgentLoginStart(view: AgentLoginCommandView, target: AgentLoginTarget): string {
  const lines = [`Starting the ${label(target)} login for ${target.host}.`];
  if (view.url) lines.push(`Open this link: ${view.url}`);
  if (view.userCode) lines.push(`Enter this code there: \`${view.userCode}\``);
  if (view.status === 'awaiting_code') {
    lines.push('Then reply in this thread with the code it gives you back.');
  } else if (view.status === 'failed') {
    lines.push(AGENT_LOGIN_REAUTH_HINT);
  } else {
    lines.push('I will post the result in this thread when it finishes.');
  }
  if (view.message) lines.push(redactTokenLike(view.message));
  return lines.join('\n');
}

export function formatAgentLoginOutcome(view: AgentLoginCommandView, target: AgentLoginTarget): string {
  const lines = [`${label(target)} login on ${target.host}: ${view.status}.`];
  if (view.message) lines.push(redactTokenLike(view.message));
  if (view.status === 'failed') lines.push(AGENT_LOGIN_REAUTH_HINT);
  return lines.join('\n');
}

export class AgentLoginThreadController {
  private readonly sessions = new Map<string, AgentLoginThreadSession>();

  constructor(private readonly deps: AgentLoginThreadDeps) {}

  async handleReply(reply: AgentLoginThreadReply): Promise<boolean> {
    let target: AgentLoginTarget | null;
    try {
      target = await this.deps.resolveTarget(reply.channel, reply.threadTs);
    } catch (err) {
      this.deps.log?.(
        'warn',
        `[AGENT_LOGIN] Could not read thread metadata (thread_ts=${reply.threadTs}): ${errorText(err)}`,
      );
      return false;
    }
    if (!target) return false;

    if (!this.deps.isAdmin(reply.userId)) {
      this.deps.log?.(
        'warn',
        `[AGENT_LOGIN] Refused non-admin reply (thread_ts=${reply.threadTs}, user=${reply.userId ?? 'unknown'})`,
      );
      await this.deps.post(AGENT_LOGIN_NOT_ADMIN_MESSAGE, reply.threadTs, reply.channel);
      return true;
    }

    const text = reply.text.trim();
    if (/^reauth$/i.test(text)) {
      await this.start(reply, target);
      return true;
    }

    const session = this.sessions.get(reply.threadTs);
    if (!session || !session.awaitingCode || !CODE_TOKEN.test(text)) {
      this.deps.log?.(
        'info',
        `[AGENT_LOGIN] Reply with no session awaiting a code (thread_ts=${reply.threadTs}, host=${target.host}, agent=${target.agent})`,
      );
      await this.deps.post(
        `No ${label(target)} login on ${target.host} is waiting for a code right now. ${AGENT_LOGIN_REAUTH_HINT}`,
        reply.threadTs,
        reply.channel,
      );
      return true;
    }

    await this.submitCode(reply, session, text);
    return true;
  }

  private async start(reply: AgentLoginThreadReply, target: AgentLoginTarget): Promise<void> {
    this.sessions.delete(reply.threadTs);
    const raw = await this.run(
      ['agent-login', 'start', target.agent, '--output', 'json'],
      reply,
      `I could not start the ${label(target)} login on ${target.host}`,
    );
    if (raw === COMMAND_FAILED) return;

    const view = normalizeAgentLoginResult(raw);
    if (!view) {
      await this.reportUnreadable(reply, target, 'start', raw);
      return;
    }

    if (view.status !== 'failed') {
      this.sessions.set(reply.threadTs, {
        sessionId: view.sessionId,
        target,
        awaitingCode: view.status === 'awaiting_code',
      });
    }
    await this.deps.post(formatAgentLoginStart(view, target), reply.threadTs, reply.channel);
  }

  private async submitCode(
    reply: AgentLoginThreadReply,
    session: AgentLoginThreadSession,
    code: string,
  ): Promise<void> {
    const { target } = session;
    const raw = await this.run(
      ['agent-login', 'code', session.sessionId, code, '--output', 'json'],
      reply,
      `I could not pass that code to the ${label(target)} login on ${target.host}`,
    );
    if (raw === COMMAND_FAILED) return;

    const view = normalizeAgentLoginResult(raw);
    if (!view) {
      await this.reportUnreadable(reply, target, 'code', raw);
      return;
    }

    if (view.status === 'failed' || view.status === 'installed') {
      this.sessions.delete(reply.threadTs);
    } else {
      this.sessions.set(reply.threadTs, {
        sessionId: view.sessionId,
        target,
        awaitingCode: view.status === 'awaiting_code',
      });
    }
    await this.deps.post(formatAgentLoginOutcome(view, target), reply.threadTs, reply.channel);
  }

  private async reportUnreadable(
    reply: AgentLoginThreadReply,
    target: AgentLoginTarget,
    subcommand: string,
    raw: unknown,
  ): Promise<void> {
    this.deps.log?.(
      'error',
      `[AGENT_LOGIN] Unreadable ${subcommand} result (thread_ts=${reply.threadTs}, host=${target.host}, agent=${target.agent}): ${describeUnreadable(raw)}`,
    );
    await this.deps.post(
      `The ${label(target)} login on ${target.host} returned a result I could not read. Nothing was changed. ${AGENT_LOGIN_REAUTH_HINT}`,
      reply.threadTs,
      reply.channel,
    );
  }

  private async run(
    args: string[],
    reply: AgentLoginThreadReply,
    failureLead: string,
  ): Promise<unknown> {
    try {
      return await this.deps.runHeadlessCommand(args);
    } catch (err) {
      const detail = errorText(err);
      this.deps.log?.(
        'error',
        `[AGENT_LOGIN] agent-login ${args[1]} failed (thread_ts=${reply.threadTs}): ${detail}`,
      );
      await this.deps.post(
        `${failureLead}: ${redactTokenLike(detail)}. The live login was left untouched. ${AGENT_LOGIN_REAUTH_HINT}`,
        reply.threadTs,
        reply.channel,
      );
      return COMMAND_FAILED;
    }
  }
}
