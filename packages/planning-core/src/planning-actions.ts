import type { PlanningMessage } from './lifecycle.js';
import { evaluatePlanningTurn } from './planning-turn.js';
import { type PlanSummary } from './plan-summary.js';

export type PlanningSessionStatus = 'still_discussing' | 'waiting_for_answer' | 'draft_ready' | 'submitted';

export interface PlanningSessionState {
  messages: PlanningMessage[];
  draftPlanText?: string;
  status: PlanningSessionStatus;
  harnessSessionId?: string;
}

export function createPlanningSessionState(harnessSessionId?: string): PlanningSessionState {
  return { messages: [], status: 'still_discussing', harnessSessionId };
}

export interface AppendPlanningTurnInput {
  state: PlanningSessionState;
  userMessage: string;
  send: (userMessage: string) => Promise<string>;
  extractDraftPlanText?: (assistantReply: string) => string | null | undefined;
  requireDraftAuthorization?: boolean;
}

export interface AppendPlanningTurnResult {
  reply: string;
  state: PlanningSessionState;
  draftingAuthorized: boolean;
  draftPlanText?: string;
  summary?: PlanSummary;
}

export async function appendPlanningTurn({
  state,
  userMessage,
  send,
  extractDraftPlanText,
  requireDraftAuthorization,
}: AppendPlanningTurnInput): Promise<AppendPlanningTurnResult> {
  const messagesBeforeTurn = state.messages;
  const reply = await send(userMessage);
  const immediateDraftPlanText = extractDraftPlanText?.(reply);
  const turn = evaluatePlanningTurn({
    userMessage,
    messagesBeforeTurn,
    assistantReply: reply,
    immediateDraftPlanText,
    requireDraftAuthorization,
    hasExistingDraft: Boolean(state.draftPlanText),
  });

  const nextMessages: PlanningMessage[] = [
    ...messagesBeforeTurn,
    { role: 'user', content: userMessage },
    { role: 'assistant', content: reply },
  ];

  if (turn.kind === 'draft_ready') {
    return {
      reply,
      state: { ...state, messages: nextMessages, draftPlanText: turn.planText, status: 'draft_ready' },
      draftingAuthorized: turn.draftingAuthorized,
      draftPlanText: turn.planText,
      summary: turn.summary,
    };
  }

  return {
    reply,
    state: { ...state, messages: nextMessages, status: turn.status },
    draftingAuthorized: turn.draftingAuthorized,
  };
}
