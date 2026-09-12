import { evaluatePlanningTurn } from './planning-turn.js';
import { summarizePlanText, type PlanSummary } from './plan-summary.js';

export type PlanningConfirmationMode = 'require' | 'auto_submit';

export interface PlanningReviewDraft {
  planText: string;
  summary: PlanSummary;
  confirmationMode: PlanningConfirmationMode;
  confirmationText: string;
  /** Opaque token binding this review to exact plan content. Required by invoker_submit_plan. */
  reviewToken?: string;
}

export interface PreparePlanningReviewInput {
  plannerOutput: string;
  extractDraftPlanText?: (output: string) => string | null | undefined;
  confirmationMode?: PlanningConfirmationMode;
}

export type PreparePlanningReviewResult =
  | PlanningReviewDraft
  | { kind: 'message'; reply: string };

export function preparePlanningReview({
  plannerOutput,
  extractDraftPlanText,
  confirmationMode = 'require',
}: PreparePlanningReviewInput): PreparePlanningReviewResult {
  const immediateDraftPlanText = extractDraftPlanText ? extractDraftPlanText(plannerOutput) : plannerOutput;
  const turn = evaluatePlanningTurn({
    userMessage: '',
    messagesBeforeTurn: [],
    assistantReply: plannerOutput,
    immediateDraftPlanText,
    requireDraftAuthorization: false,
  });

  if (turn.kind !== 'draft_ready') {
    return { kind: 'message', reply: plannerOutput };
  }

  return {
    planText: turn.planText,
    summary: turn.summary,
    confirmationMode,
    confirmationText: confirmationTextForMode(confirmationMode),
  };
}

export interface PlanningReviewLoadResult {
  planName: string;
  workflowId: string;
  workflowIds?: string[];
  workflowCount?: number;
}

export interface SubmitPlanningReviewInput {
  planText: string | null | undefined;
  loadPlan: (planText: string) => PlanningReviewLoadResult | Promise<PlanningReviewLoadResult>;
}

export type SubmitPlanningReviewResult =
  | ({ ok: true; summary: PlanSummary } & PlanningReviewLoadResult)
  | { ok: false; error: string };

export async function submitPlanningReview({
  planText,
  loadPlan,
}: SubmitPlanningReviewInput): Promise<SubmitPlanningReviewResult> {
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

export function confirmationTextForMode(confirmationMode: PlanningConfirmationMode): string {
  return confirmationMode === 'auto_submit'
    ? 'Auto-submit is enabled. Submit this exact YAML now.'
    : 'Approve to submit this exact YAML. Cancel keeps the draft. Discard removes it.';
}
