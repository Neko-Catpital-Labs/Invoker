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

interface DeletePlanningChatDeps {
  sessions: InAppPlanningChatSessions;
  planningSessionStore?: InAppPlanningSessionStore;
  conversationRepo?: Pick<ConversationRepository, 'deleteConversation'>;
  closeTerminal?: (terminalSessionId: string) => void;
}

function logPlanningCleanupError(sessionId: string, step: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[in-app-planner] failed to ${step} for planning session "${sessionId}": ${message}`);
}

function cleanupPlanningChatSession(
  sessionId: string,
  deps: DeletePlanningChatDeps,
  session: InAppPlanningChatSession | undefined,
): void {
  if (session?.terminalSessionId) {
    try {
      deps.closeTerminal?.(session.terminalSessionId);
    } catch (error) {
      logPlanningCleanupError(sessionId, `close terminal "${session.terminalSessionId}"`, error);
    }
  }

  try {
    deps.sessions.delete(sessionId);
  } catch (error) {
    logPlanningCleanupError(sessionId, 'delete in-memory session', error);
  }

  try {
    deps.planningSessionStore?.deleteInAppPlanningSession(sessionId);
  } catch (error) {
    logPlanningCleanupError(sessionId, 'delete persisted planning session', error);
  }

  try {
    deps.conversationRepo?.deleteConversation(sessionId);
  } catch (error) {
    logPlanningCleanupError(sessionId, 'delete override conversation', error);
  }
}

export function deletePlanningChat(
  request: InAppPlanningDeleteRequest,
  deps: DeletePlanningChatDeps,
): InAppPlanningDeleteResponse {
  const sessionId = String(request?.sessionId ?? '').trim();
  if (!sessionId) {
    return { ok: false, error: 'Planning session id is required.' };
  }

  cleanupPlanningChatSession(sessionId, deps, deps.sessions.get(sessionId));
  return { ok: true };
}

export function deleteSubmittedPlanningChats(
  deps: DeletePlanningChatDeps,
): InAppPlanningDeleteSubmittedResponse {
  const submittedSessionIds = [...deps.sessions.values()]
    .filter((session) => session.status === 'submitted')
    .map((session) => session.id);

  for (const sessionId of submittedSessionIds) {
    cleanupPlanningChatSession(sessionId, deps, deps.sessions.get(sessionId));
  }

  return { ok: true, deletedSessionIds: submittedSessionIds };
}
