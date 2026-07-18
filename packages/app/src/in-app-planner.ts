import type {
  InAppPlanningDeleteRequest,
  InAppPlanningDeleteResponse,
  InAppPlanningDeleteSubmittedResponse,
} from '@invoker/contracts';
import type { ConversationRepository } from '@invoker/data-store';

export interface InAppPlanningSessionStore {
  deleteInAppPlanningSession(sessionId: string): void;
}

export interface InAppPlanningChatSession {
  id: string;
  status: string;
  terminalSessionId?: string;
}

export type InAppPlanningChatSessions = Map<string, InAppPlanningChatSession>;

export function createInAppPlanningChatSessions(): InAppPlanningChatSessions {
  return new Map();
}

type PlanningConversationRepo =
  Pick<ConversationRepository, 'deleteConversation'> &
  Partial<Pick<ConversationRepository, 'listSubmittedConversations'>>;

interface PlanningChatDeleteLogger {
  error(message: string, context?: Record<string, unknown>): void;
}

export interface PlanningChatDeleteDeps {
  sessions: InAppPlanningChatSessions;
  planningSessionStore?: Pick<InAppPlanningSessionStore, 'deleteInAppPlanningSession'>;
  conversationRepo?: PlanningConversationRepo;
  closeTerminal?: (terminalSessionId: string) => void;
  logger?: PlanningChatDeleteLogger;
}

function logPlanningChatDeleteError(
  deps: Pick<PlanningChatDeleteDeps, 'logger'>,
  sessionId: string,
  step: string,
  error: unknown,
): void {
  const message = `delete planning chat failed session="${sessionId}" step="${step}": ${
    error instanceof Error ? error.message : String(error)
  }`;
  if (deps.logger) {
    deps.logger.error(message, { module: 'planning-chat' });
    return;
  }
  console.error(`[planning-chat] ${message}`);
}

function runPlanningChatDeleteStep(
  deps: Pick<PlanningChatDeleteDeps, 'logger'>,
  sessionId: string,
  step: string,
  cleanup: () => void,
): void {
  try {
    cleanup();
  } catch (error) {
    logPlanningChatDeleteError(deps, sessionId, step, error);
  }
}

function cleanupPlanningChatSession(
  sessionId: string,
  session: InAppPlanningChatSession | undefined,
  deps: PlanningChatDeleteDeps,
): void {
  const terminalSessionId = session?.terminalSessionId;
  if (terminalSessionId) {
    runPlanningChatDeleteStep(deps, sessionId, 'close-terminal', () => {
      deps.closeTerminal?.(terminalSessionId);
    });
  }

  runPlanningChatDeleteStep(deps, sessionId, 'delete-memory-session', () => {
    deps.sessions.delete(sessionId);
  });
  runPlanningChatDeleteStep(deps, sessionId, 'delete-persisted-planning-session', () => {
    deps.planningSessionStore?.deleteInAppPlanningSession(sessionId);
  });
  runPlanningChatDeleteStep(deps, sessionId, 'delete-override-conversation', () => {
    deps.conversationRepo?.deleteConversation(sessionId);
  });
}

export function deletePlanningChat(
  request: InAppPlanningDeleteRequest,
  deps: PlanningChatDeleteDeps,
): InAppPlanningDeleteResponse {
  const sessionId = typeof request?.sessionId === 'string' ? request.sessionId.trim() : '';
  if (!sessionId) {
    return { ok: false, error: 'Planning session id is required.' };
  }

  cleanupPlanningChatSession(sessionId, deps.sessions.get(sessionId), deps);
  return { ok: true };
}

export function deleteSubmittedPlanningChats(
  deps: PlanningChatDeleteDeps,
): InAppPlanningDeleteSubmittedResponse {
  const submittedSessionIds = new Set(
    [...deps.sessions.values()]
      .filter((session) => session.status === 'submitted')
      .map((session) => session.id),
  );

  for (const conversation of deps.conversationRepo?.listSubmittedConversations?.() ?? []) {
    submittedSessionIds.add(conversation.threadTs);
  }

  const deletedSessionIds = [...submittedSessionIds];

  for (const sessionId of deletedSessionIds) {
    cleanupPlanningChatSession(sessionId, deps.sessions.get(sessionId), deps);
  }

  return { ok: true, deletedSessionIds };
}
