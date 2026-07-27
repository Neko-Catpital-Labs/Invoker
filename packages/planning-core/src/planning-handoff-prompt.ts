import type { PlanningConfirmationMode } from './planning-review.js';

export interface BuildPlanningHandoffInstructionsOptions {
  planFilePath?: string;
  confirmationMode?: PlanningConfirmationMode;
  reviewInstruction?: string;
  shortReplyInstruction?: string;
  submissionInstruction?: string;
}

export function buildPlanningHandoffInstructions({
  planFilePath,
  confirmationMode = 'require',
  reviewInstruction,
  shortReplyInstruction,
  submissionInstruction,
}: BuildPlanningHandoffInstructionsOptions = {}): string {
  const outputInstruction = planFilePath
    ? [
        `When the final YAML plan is ready, write the COMPLETE YAML to \`${planFilePath}\` using your file-writing tool.`,
        shortReplyInstruction ?? 'Then reply with only a short summary. Never paste the YAML into chat.',
      ].join(' ')
    : 'When the final YAML plan is ready, output the COMPLETE YAML inside a ```yaml code block.';
  const orderedStepInstruction = reviewInstruction
    ?? 'After the YAML exists, review the exact same YAML and show its ordered steps.';
  const confirmationInstruction = confirmationMode === 'auto_submit'
    ? 'Auto-submit is enabled. After that review step, continue straight to the designated submission step without an extra approval pause.'
    : 'After that review step, wait for approval before any submission step.';
  return [
    outputInstruction,
    orderedStepInstruction,
    confirmationInstruction,
    'Do not skip the review flow by validating, submitting, or executing the plan before the exact YAML has been shown back to the user.',
    'Before that review step completes, do not call `invoker-cli`, `invoker_submit_plan`, `invoker_validate_plan`, or `submit-plan.sh`.',
    submissionInstruction ?? 'Only the designated review flow may submit the plan after approval.',
    'Do not tell the user to reply `submit`; approval belongs to the review flow.',
  ].join(' ');
}
