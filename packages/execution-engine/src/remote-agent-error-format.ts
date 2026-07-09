const TASK_SCOPED_HEADLESS_COMMANDS = new Set([
  'approve',
  'reject',
  'fix',
  'resolve-conflict',
  'cancel',
  'retry-task',
  'recreate-task',
  'delete-task',
  'select',
  'input',
]);

const TASK_SCOPED_SET_SUBCOMMANDS = new Set([
  'command',
  'prompt',
  'executor',
  'agent',
  'fix-prompt',
  'fix-context',
  'gate-policy',
  'task',
  'model',
]);

function unwrapNestedJsonMessage(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  let current: unknown = raw;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current !== 'string') break;
    const trimmed = current.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return trimmed;
    }
    try {
      current = JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  if (typeof current === 'object' && current !== null) {
    const record = current as Record<string, unknown>;
    const nestedError = record.error;
    if (typeof nestedError === 'object' && nestedError !== null) {
      const message = (nestedError as Record<string, unknown>).message;
      if (typeof message === 'string' && message.trim()) return message.trim();
    }
    const message = record.message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return typeof raw === 'string' ? raw.trim() : undefined;
}

function extractMessageFromJsonLine(line: string): string | undefined {
  try {
    const entry = JSON.parse(line) as Record<string, unknown>;
    if (entry.type === 'error' && entry.message !== undefined) {
      return unwrapNestedJsonMessage(entry.message);
    }
    if (entry.type === 'turn.failed') {
      const turnError = entry.error;
      if (typeof turnError === 'object' && turnError !== null) {
        return unwrapNestedJsonMessage((turnError as Record<string, unknown>).message);
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function stdoutSection(raw: string): string | undefined {
  const marker = 'STDOUT:';
  const idx = raw.indexOf(marker);
  if (idx < 0) return undefined;
  return raw.slice(idx + marker.length).replace(/^\n+/, '');
}

export function extractLegibleAgentFailure(raw: string): string | undefined {
  const section = stdoutSection(raw) ?? raw;
  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    const message = extractMessageFromJsonLine(trimmed);
    if (message) return message;
  }
  return undefined;
}

export function formatRemoteAgentFailureForTask(raw: string): string {
  const stackIdx = raw.indexOf('\n    at ');
  const withoutStack = stackIdx >= 0 ? raw.slice(0, stackIdx) : raw;
  const legible = extractLegibleAgentFailure(withoutStack);
  if (!legible) return withoutStack.trim();

  const header = withoutStack.split('\n')[0]?.trim() ?? 'Remote agent fix failed';
  return `${header}\n${legible}`;
}

export function formatAgentFailureForTask(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return formatRemoteAgentFailureForTask(raw);
}

export function resolveHeadlessExecTaskId(args: unknown[]): string | undefined {
  const payload = args[0] as { args?: unknown[] } | undefined;
  const rawArgs = Array.isArray(payload?.args) ? payload.args : [];
  const command = typeof rawArgs[0] === 'string' ? rawArgs[0] : '';
  if (!command) return undefined;

  if (TASK_SCOPED_HEADLESS_COMMANDS.has(command)) {
    const target = typeof rawArgs[1] === 'string' ? rawArgs[1] : '';
    return target.includes('/') ? target : undefined;
  }

  if (command === 'set') {
    const subCommand = typeof rawArgs[1] === 'string' ? rawArgs[1] : '';
    if (!TASK_SCOPED_SET_SUBCOMMANDS.has(subCommand)) return undefined;
    const target = typeof rawArgs[2] === 'string' ? rawArgs[2] : '';
    return target.includes('/') ? target : undefined;
  }

  return undefined;
}
