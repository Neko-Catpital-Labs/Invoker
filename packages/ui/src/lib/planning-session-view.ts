import type {
  InAppPlanningSessionStatus,
  InAppPlanningSessionSummary,
  PlanningConfirmationMode,
  TerminalSessionDescriptor,
} from '@invoker/contracts';
import type { InvokerTerminalLine, PlanningTerminalMode } from '../components/InvokerTerminal.js';

export type PlanningSessionView = Omit<InAppPlanningSessionSummary, 'messages'> & {
  messages: InvokerTerminalLine[];
  input: string;
  busy: boolean;
  conversationKey: string;
  mode: PlanningTerminalMode;
  terminalSession?: TerminalSessionDescriptor | null;
  terminalBusy?: boolean;
  terminalError?: string | null;
  repoInput?: string;
  repoError?: string | null;
};

export function planningSessionFromSummary(
  summary: InAppPlanningSessionSummary,
  overrides: Partial<PlanningSessionView> = {},
): PlanningSessionView {
  const restoredTerminalSession = summary.terminalSessionId
    && (summary.terminalStatus === 'running' || summary.terminalStatus === 'exited')
    ? {
        sessionId: summary.terminalSessionId,
        taskId: `planning:${summary.id}`,
        kind: 'planning' as const,
        planningSessionId: summary.id,
        status: summary.terminalStatus,
        exitCode: summary.terminalExitCode,
        cwd: undefined,
        mode: 'spawn' as const,
        attached: false,
        createdAt: summary.terminalUpdatedAt ?? summary.updatedAt,
        outputSnapshot: summary.terminalOutputSnapshot ?? '',
      }
    : null;
  return {
    ...summary,
    messages: summary.messages.map((line) => ({
      id: line.id,
      text: line.text,
      role: line.role,
      tone: line.tone,
    })),
    input: '',
    busy: summary.activeTurnStatus === 'running',
    conversationKey: summary.id,
    mode: summary.terminalMode ?? 'chat',
    terminalSession: restoredTerminalSession,
    terminalBusy: false,
    terminalError: null,
    ...overrides,
  };
}

export type PlanningStreamState = {
  text: string;
  status: 'streaming' | 'failed';
};

export function makeInitialPlanningSession(
  now: string = new Date().toISOString(),
  confirmationMode: PlanningConfirmationMode = 'require',
): PlanningSessionView {
  return {
    id: 'local-planning-session-1',
    title: 'Untitled plan',
    status: 'still_discussing',
    presetKey: '',
    confirmationMode,
    messages: [],
    input: '',
    draftPlanAvailable: false,
    busy: false,
    createdAt: now,
    updatedAt: now,
    conversationKey: 'local-planning-session-1',
    mode: 'chat',
    terminalSession: null,
    terminalBusy: false,
    terminalError: null,
  };
}

export function isInitialPlanningSessionPlaceholder(session: PlanningSessionView | undefined): boolean {
  if (!session) return false;
  return session.id === 'local-planning-session-1'
    && session.title === 'Untitled plan'
    && session.input === ''
    && !session.busy
    && session.messages.length === 0
    && !session.draftPlanAvailable
    && !session.terminalSession
    && !session.terminalBusy
    && !session.terminalError;
}

export function reconcileHydratedPlanningSessions(
  currentSessions: PlanningSessionView[],
  restoredSessions: PlanningSessionView[],
): PlanningSessionView[] {
  if (restoredSessions.length === 0) return currentSessions;
  if (
    currentSessions.length === 0
    || (currentSessions.length === 1 && isInitialPlanningSessionPlaceholder(currentSessions[0]))
  ) {
    return restoredSessions;
  }

  const restoredById = new Map(restoredSessions.map((session) => [session.id, session]));
  const currentIds = new Set(currentSessions.map((session) => session.id));
  const mergedCurrentSessions = currentSessions.map((session) => {
    const restored = restoredById.get(session.id);
    if (!restored) return session;
    return {
      ...restored,
      input: session.input,
      busy: restored.activeTurnStatus === 'running',
      conversationKey: session.conversationKey,
      mode: session.mode === 'tmux' || restored.mode === 'tmux' ? 'tmux' : restored.mode,
      terminalSession: restored.terminalSession ?? session.terminalSession,
      terminalBusy: restored.terminalSession ? false : session.terminalBusy,
      terminalError: restored.terminalSession ? null : session.terminalError,
      repoInput: session.repoInput,
      repoError: session.repoError,
    };
  });
  const newRestoredSessions = restoredSessions.filter((session) => !currentIds.has(session.id));
  return [...mergedCurrentSessions, ...newRestoredSessions];
}

export function planningSessionSummaryToView(session: InAppPlanningSessionSummary): PlanningSessionView {
  return planningSessionFromSummary(session);
}

export function maxPlanningMessageId(sessions: PlanningSessionView[]): number {
  let max = 1;
  for (const session of sessions) {
    for (const message of session.messages) {
      if (message.id > max) max = message.id;
    }
  }
  return max;
}

export function planningNeedsAttention(status: InAppPlanningSessionStatus): boolean {
  return status === 'waiting_for_answer' || status === 'draft_ready';
}

export function planningRepoLabel(repoUrl: string): string {
  const trimmed = repoUrl.trim().replace(/\.git$/, '');
  const segments = trimmed.split(/[/:]/).filter(Boolean);
  return segments.length >= 2 ? segments.slice(-2).join('/') : (segments.at(-1) ?? trimmed);
}

export function planningRepoStatusText(repoUrl: string | undefined, baseCommit: string | undefined): string {
  if (!repoUrl) return 'No repository bound yet';
  const label = planningRepoLabel(repoUrl);
  return baseCommit ? `${label} @ ${baseCommit.slice(0, 7)}` : label;
}

export function newPlanningTurnId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `turn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function previewPlanningMessage(session: PlanningSessionView): string {
  const last = [...session.messages].reverse().find((line) => line.role !== 'system') ?? session.messages.at(-1);
  return last?.text.replace(/\s+/g, ' ').trim() || 'No messages yet';
}

export function planningSessionStatusLabel(session: PlanningSessionView): string {
  if (session.busy) return 'Working';
  if (session.status === 'draft_ready') return 'Draft ready';
  if (session.status === 'waiting_for_answer') return 'Waiting for answer';
  if (session.status === 'submitted') return 'Submitted';
  return 'Still discussing';
}

export function relativePlanningUpdatedAt(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'now';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.round(months / 12)}y`;
}
