export type PlanningChatInlineSegment =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string };

export interface PlanningChatErrorPresentation {
  title: string;
  body: string;
  copyCommand: string | null;
}

export function extractPlanningChatCopyCommand(text: string): string | null {
  const commands = [...text.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1]?.trim() ?? '')
    .filter(Boolean);
  if (commands.length === 0) return null;
  // Prefer the direct agent binary — `cursor agent login` can hang on status.
  const preferred = commands.find((command) => command === 'cursor-agent login');
  return preferred ?? commands[0] ?? null;
}

export function splitPlanningChatInlineCode(text: string): PlanningChatInlineSegment[] {
  const segments: PlanningChatInlineSegment[] = [];
  const pattern = /`([^`]+)`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', text: text.slice(lastIndex, match.index) });
    }
    const code = match[1] ?? '';
    if (code) {
      segments.push({ kind: 'code', text: code });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: 'text', text: text.slice(lastIndex) });
  }
  return segments.length > 0 ? segments : [{ kind: 'text', text }];
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^(.+?[.!?])(?:\s|$)/);
  return (match?.[1] ?? trimmed.split('\n')[0] ?? trimmed).trim();
}

const AUTH_PREFIX_PATTERN =
  /^(.+?)(?:\s+isn't authenticated\.?|: Authentication required\.?)\s*/i;

export function humanizePlanningChatErrorTitle(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'Something went wrong';

  const authMatch = trimmed.match(AUTH_PREFIX_PATTERN);
  if (authMatch?.[1]) {
    return `${authMatch[1].trim()} isn't signed in`;
  }

  if (/interrupted/i.test(trimmed)) {
    return 'Planning was interrupted';
  }

  if (/^cancelled\.?$/i.test(trimmed)) {
    return 'Planning cancelled';
  }

  return firstSentence(trimmed);
}

export function presentPlanningChatError(raw: string): PlanningChatErrorPresentation {
  const trimmed = raw.trim();
  const title = humanizePlanningChatErrorTitle(trimmed);
  let body = trimmed;

  const authMatch = trimmed.match(AUTH_PREFIX_PATTERN);
  if (authMatch) {
    body = trimmed.slice(authMatch[0].length).trim();
  } else if (/interrupted/i.test(trimmed)) {
    body = trimmed;
  } else if (trimmed.toLowerCase().startsWith(title.toLowerCase())) {
    body = trimmed.slice(title.length).replace(/^[:.\s]+/, '').trim();
  } else {
    const first = firstSentence(trimmed);
    if (trimmed.startsWith(first)) {
      body = trimmed.slice(first.length).replace(/^[:.\s]+/, '').trim();
    }
  }
  if (body.toLowerCase() === title.toLowerCase()) {
    body = '';
  }
  return {
    title,
    body,
    copyCommand: extractPlanningChatCopyCommand(trimmed),
  };
}

export type PlanningChatSenderKind = 'user' | 'assistant' | 'system-error' | 'system-notice';

export interface PlanningChatCollapsedLine {
  id: number;
  text: string;
  role: 'user' | 'assistant' | 'system';
  tone?: 'muted' | 'error' | 'success';
  count: number;
  kind: PlanningChatSenderKind;
}

export function planningChatSenderKind(
  role: 'user' | 'assistant' | 'system',
  tone?: 'muted' | 'error' | 'success',
): PlanningChatSenderKind {
  if (role === 'user') return 'user';
  if (role === 'assistant') return 'assistant';
  if (tone === 'error') return 'system-error';
  return 'system-notice';
}

/** Presentational collapse of consecutive identical system errors. Does not mutate storage. */
export function collapsePlanningChatLines<T extends {
  id: number;
  text: string;
  role: 'user' | 'assistant' | 'system';
  tone?: 'muted' | 'error' | 'success';
}>(lines: T[]): PlanningChatCollapsedLine[] {
  const collapsed: PlanningChatCollapsedLine[] = [];
  for (const line of lines) {
    const kind = planningChatSenderKind(line.role, line.tone);
    const previous = collapsed[collapsed.length - 1];
    if (
      previous
      && kind === 'system-error'
      && previous.kind === 'system-error'
      && previous.text === line.text
    ) {
      previous.count += 1;
      continue;
    }
    collapsed.push({
      id: line.id,
      text: line.text,
      role: line.role,
      tone: line.tone,
      count: 1,
      kind,
    });
  }
  return collapsed;
}

export interface PlanningChatMessageGroup {
  kind: PlanningChatSenderKind;
  items: PlanningChatCollapsedLine[];
}

export function groupPlanningChatLines(
  collapsed: PlanningChatCollapsedLine[],
): PlanningChatMessageGroup[] {
  const groups: PlanningChatMessageGroup[] = [];
  for (const item of collapsed) {
    const last = groups[groups.length - 1];
    if (last && last.kind === item.kind) {
      last.items.push(item);
      continue;
    }
    groups.push({ kind: item.kind, items: [item] });
  }
  return groups;
}
