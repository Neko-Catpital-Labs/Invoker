import {
  isDraftingAuthorized,
  type PlanningMessage,
} from './lifecycle.js';
import {
  summarizePlanText,
  type PlanSummary,
} from './plan-summary.js';

export type SharedPlanningTurn =
  | {
      kind: 'message';
      text: string;
      status: 'still_discussing' | 'waiting_for_answer';
      draftingAuthorized: boolean;
    }
  | {
      kind: 'draft_ready';
      text: string;
      planText: string;
      summary: PlanSummary;
      draftingAuthorized: boolean;
    };

export interface EvaluatePlanningTurnInput {
  userMessage: string;
  messagesBeforeTurn: readonly PlanningMessage[];
  assistantReply: string;
  immediateDraftPlanText: string | null | undefined;
  requireDraftAuthorization?: boolean;
  hasExistingDraft?: boolean;
}

export function evaluatePlanningTurn({
  userMessage,
  messagesBeforeTurn,
  assistantReply,
  immediateDraftPlanText,
  requireDraftAuthorization = true,
  hasExistingDraft = false,
}: EvaluatePlanningTurnInput): SharedPlanningTurn {
  const draftingAuthorized = !requireDraftAuthorization
    || isDraftingAuthorized(userMessage, messagesBeforeTurn);
  const planText = immediateDraftPlanText?.trim() || null;
  const summary = planText ? summarizePlanText(planText) : null;

  if (planText && summary && (!hasExistingDraft || draftingAuthorized)) {
    return {
      kind: 'draft_ready',
      text: assistantReply,
      planText,
      summary,
      draftingAuthorized,
    };
  }

  return {
    kind: 'message',
    text: assistantReply,
    status: assistantReply.includes('?') ? 'waiting_for_answer' : 'still_discussing',
    draftingAuthorized,
  };
}
