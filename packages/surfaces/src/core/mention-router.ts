import { resolvePlanningSubmitAction } from '@invoker/planning-core';
import type { PlanDraftRecord } from '../approval/chat-transport.js';
import {
  parseChannelRepoSetupRequest,
  parsePlanningRequest,
} from '../slack/mention-parsers.js';
import type { ChannelRepoSetupPair } from '../slack/mention-parsers.js';
import { parseWorkflowControl } from '../slack/workflow-assistant.js';
import type { WorkflowControl } from '../slack/workflow-assistant.js';

export type ParsedPlanningRequest = ReturnType<typeof parsePlanningRequest>;

export interface MentionMessage {
  text: string;
  userId?: string;
}

export interface MentionRoutingContext {
  presetKeys: string[];
  defaultPresetKey: string;
  readyDraft: () => PlanDraftRecord | undefined;
}

export type WorkflowMentionRoute =
  | { kind: 'workflow_help' }
  | { kind: 'workflow_control'; control: WorkflowControl }
  | { kind: 'workflow_question'; text: string };

export type PlanningMentionRoute =
  | { kind: 'unknown_preset'; preset: string }
  | { kind: 'greeting' }
  | { kind: 'explicit_plan' }
  | { kind: 'channel_repo_setup'; pairs: ChannelRepoSetupPair[] }
  | { kind: 'submit_ready_draft'; draft: PlanDraftRecord; userId: string }
  | { kind: 'submit_denied' }
  | { kind: 'resolve_repo' };

export interface PlanningMention {
  parsed: ParsedPlanningRequest;
  announceAutoSubmitUnavailable: boolean;
  route: PlanningMentionRoute;
}

export function routeWorkflowMention(rawText: string): WorkflowMentionRoute {
  const text = rawText.replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!text) return { kind: 'workflow_help' };
  const control = parseWorkflowControl(text);
  if (control) return { kind: 'workflow_control', control };
  return { kind: 'workflow_question', text };
}

export function routePlanningMention(message: MentionMessage, context: MentionRoutingContext): PlanningMention {
  const parsed = parsePlanningRequest(message.text, context.presetKeys, context.defaultPresetKey);
  const route = choosePlanningRoute(parsed, message.userId, context);
  const announceAutoSubmitUnavailable = Boolean(parsed.autoSubmitRequested)
    && route.kind !== 'unknown_preset'
    && route.kind !== 'greeting';
  return { parsed, announceAutoSubmitUnavailable, route };
}

export function choosePlanningRoute(
  parsed: ParsedPlanningRequest,
  userId: string | undefined,
  context: MentionRoutingContext,
): PlanningMentionRoute {
  if (parsed.unknownPreset) return { kind: 'unknown_preset', preset: parsed.unknownPreset };
  if (!parsed.text) return { kind: 'greeting' };
  if (/^\/plan\s*$/i.test(parsed.text)) return { kind: 'explicit_plan' };

  const pairs = parseChannelRepoSetupRequest(parsed.text);
  if (pairs) return { kind: 'channel_repo_setup', pairs };

  const readyDraft = context.readyDraft();
  if (resolvePlanningSubmitAction(parsed.text, Boolean(readyDraft)) === 'submit_ready' && readyDraft) {
    return userId && readyDraft.requestedBy === userId
      ? { kind: 'submit_ready_draft', draft: readyDraft, userId }
      : { kind: 'submit_denied' };
  }
  return { kind: 'resolve_repo' };
}
