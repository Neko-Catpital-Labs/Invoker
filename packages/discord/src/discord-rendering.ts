import { formatPlanSummaryLines, type PlanSummary } from '@invoker/planning-core';
import { splitForSlack, type ChatBlocks, type PlanDraftRecord } from '@invoker/surfaces';
import type { DiscordButton, DiscordMessagePayload } from './gateway.js';

export type DiscordBlock =
  | { kind: 'body'; text: string }
  | { kind: 'buttons'; buttons: DiscordButton[] };

export const DiscordAction = {
  planDraftApprove: 'plan_draft_approve',
  planDraftCancel: 'plan_draft_cancel',
  planDraftDiscard: 'plan_draft_discard',
  planForExecution: 'lobby_plan_for_execution',
  continueConversation: 'lobby_continue_conversation',
  confirm: 'lobby_confirm',
  cancel: 'lobby_cancel',
} as const;

export function buttonId(action: string, value: string): string {
  return `${action}:${value}`;
}

export function parseButtonId(customId: string): { action: string; value: string } {
  const separator = customId.indexOf(':');
  if (separator === -1) return { action: customId, value: '' };
  return { action: customId.slice(0, separator), value: customId.slice(separator + 1) };
}

export type OverflowNote = (hiddenLines: number) => string;

const defaultOverflowNote: OverflowNote = (hidden) => `… ${hidden} more line${hidden === 1 ? '' : 's'}`;

export function fitMessage(text: string, limit: number, overflowNote: OverflowNote = defaultOverflowNote): string {
  if (text.length <= limit) return text;
  const lines = text.split('\n');
  const reserve = overflowNote(lines.length).length + 1;
  const budget = limit - reserve;
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = line.length + (kept.length ? 1 : 0);
    if (used + cost > budget) break;
    kept.push(line);
    used += cost;
  }
  if (!kept.length) kept.push(`${lines[0].slice(0, Math.max(0, budget - 1))}…`);
  return [...kept, overflowNote(lines.length - kept.length)].join('\n').slice(0, limit);
}

export function chunkMessage(text: string, limit: number): string[] {
  return splitForSlack(text, limit).flatMap((chunk) => {
    const pieces: string[] = [];
    for (let start = 0; start < chunk.length; start += limit) pieces.push(chunk.slice(start, start + limit));
    return pieces.length ? pieces : [chunk];
  });
}

export function renderReviewBody(summary: PlanSummary, state: 'ready' | 'kept', limit: number): string {
  const footer = state === 'kept' ? 'Plan not submitted. Draft kept.' : '';
  const budget = footer ? limit - footer.length - 1 : limit;
  const steps = fitMessage(
    [`**${summary.name}**`, ...formatPlanSummaryLines(summary)].join('\n'),
    budget,
    (hidden) => `… ${hidden} more step${hidden === 1 ? '' : 's'} in the attached YAML`,
  );
  return footer ? `${steps}\n${footer}` : steps;
}

function draftButtons(draft: PlanDraftRecord, state: 'ready' | 'kept'): DiscordButton[] {
  const value = `${draft.draftId}:${draft.version}`;
  const approve: DiscordButton = { customId: buttonId(DiscordAction.planDraftApprove, value), label: 'Approve', style: 'primary' };
  return state === 'ready'
    ? [approve, { customId: buttonId(DiscordAction.planDraftCancel, value), label: 'Cancel', style: 'secondary' }]
    : [approve, { customId: buttonId(DiscordAction.planDraftDiscard, value), label: 'Discard draft', style: 'danger' }];
}

function asDiscordBlocks(blocks: unknown[] | undefined): DiscordBlock[] {
  return (blocks ?? []) as DiscordBlock[];
}

export function describeButtons(blocks: unknown[] | undefined): string {
  const ids = asDiscordBlocks(blocks).flatMap((block) => (block.kind === 'buttons' ? block.buttons.map((b) => b.customId) : []));
  return ids.length ? ids.join(',') : 'none';
}

export function toDiscordPayload(text: string, blocks: unknown[] | undefined, limit: number): DiscordMessagePayload {
  const discordBlocks = asDiscordBlocks(blocks);
  const body = discordBlocks.find((block): block is Extract<DiscordBlock, { kind: 'body' }> => block.kind === 'body');
  const buttons = discordBlocks.flatMap((block) => (block.kind === 'buttons' ? block.buttons : []));
  return { content: fitMessage(body?.text ?? text, limit), buttons };
}

export function createDiscordBlocks(limit: number): ChatBlocks {
  return {
    confirmPrompt: (prompt, confirmKey) => [
      { kind: 'body', text: fitMessage(prompt, limit) },
      {
        kind: 'buttons',
        buttons: [
          { customId: buttonId(DiscordAction.confirm, confirmKey), label: 'Approve', style: 'primary' },
          { customId: buttonId(DiscordAction.cancel, confirmKey), label: 'Reject', style: 'secondary' },
        ],
      },
    ] satisfies DiscordBlock[],
    planIntentPrompt: (confirmKey) => [
      { kind: 'body', text: 'It sounds like you may want an Invoker plan that can be executed. Which should I do?' },
      {
        kind: 'buttons',
        buttons: [
          { customId: buttonId(DiscordAction.planForExecution, confirmKey), label: 'Plan for execution', style: 'primary' },
          { customId: buttonId(DiscordAction.continueConversation, confirmKey), label: 'No planning, just continue conversation', style: 'secondary' },
        ],
      },
    ] satisfies DiscordBlock[],
    planDraftCard: (summary, draft, state) => [
      { kind: 'body', text: renderReviewBody(summary, state, limit) },
      { kind: 'buttons', buttons: draftButtons(draft, state) },
    ] satisfies DiscordBlock[],
    describeActions: describeButtons,
  };
}
