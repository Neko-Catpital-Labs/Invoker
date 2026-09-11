import { parseWorkflowControl } from '../slack/workflow-assistant.js';
import type { WorkflowControl } from '../slack/workflow-assistant.js';

export type WorkflowMentionRoute =
  | { kind: 'workflow_help' }
  | { kind: 'workflow_control'; control: WorkflowControl }
  | { kind: 'workflow_question'; text: string };

export function routeWorkflowMention(rawText: string): WorkflowMentionRoute {
  const text = rawText.replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!text) return { kind: 'workflow_help' };
  const control = parseWorkflowControl(text);
  if (control) return { kind: 'workflow_control', control };
  return { kind: 'workflow_question', text };
}
