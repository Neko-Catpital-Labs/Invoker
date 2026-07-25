import type { PlanningMessage } from './lifecycle.js';
import { evaluatePlanningTurn } from './planning-turn.js';
import { summarizePlanText, type PlanSummary } from './plan-summary.js';

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
      draftingAuthorized: true,
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

export interface RunPlanToInvokerInput {
  convert: () => Promise<string>;
  extractDraftPlanText?: (output: string) => string | null | undefined;
}

export type RunPlanToInvokerResult =
  | { kind: 'draft_ready'; planText: string; summary: PlanSummary; reply: string }
  | { kind: 'message'; reply: string };

export async function runPlanToInvoker({
  convert,
  extractDraftPlanText,
}: RunPlanToInvokerInput): Promise<RunPlanToInvokerResult> {
  const reply = await convert();
  const immediateDraftPlanText = extractDraftPlanText ? extractDraftPlanText(reply) : reply;
  const turn = evaluatePlanningTurn({
    userMessage: '',
    messagesBeforeTurn: [],
    assistantReply: reply,
    immediateDraftPlanText,
    requireDraftAuthorization: false,
  });

  if (turn.kind === 'draft_ready') {
    return { kind: 'draft_ready', planText: turn.planText, summary: turn.summary, reply };
  }
  return { kind: 'message', reply };
}

export interface ApprovedPlanLoadResult {
  planName: string;
  workflowId: string;
  workflowIds?: string[];
  workflowCount?: number;
}

export interface ApprovePlanningDraftInput {
  planText: string | null | undefined;
  loadPlan: (planText: string) => ApprovedPlanLoadResult | Promise<ApprovedPlanLoadResult>;
}

export type ApprovePlanningDraftResult =
  | ({ ok: true; summary: PlanSummary } & ApprovedPlanLoadResult)
  | { ok: false; error: string };

export async function approvePlanningDraft({
  planText,
  loadPlan,
}: ApprovePlanningDraftInput): Promise<ApprovePlanningDraftResult> {
  if (!planText) {
    return { ok: false, error: 'No complete plan drafted yet. Ask the AI to create a full plan, then submit again.' };
  }
  const summary = summarizePlanText(planText);
  if (!summary) {
    return { ok: false, error: 'I found a draft plan but could not read it. Ask the AI to regenerate the plan, then submit again.' };
  }
  try {
    const loaded = await loadPlan(planText);
    return { ok: true, summary, ...loaded };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
