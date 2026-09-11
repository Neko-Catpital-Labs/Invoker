import { describe, it, expect, vi } from 'vitest';
import { routeWorkflowMention } from '../core/mention-router.js';
import type { WorkflowMentionRoute } from '../core/mention-router.js';

vi.mock('@slack/bolt', () => {
  throw new Error('@slack/bolt was loaded by the transport-agnostic mention router');
});

interface WorkflowCase {
  covers: string;
  text: string;
  route: WorkflowMentionRoute;
}

const WORKFLOW_CASES: WorkflowCase[] = [
  { covers: 'slack-surface-workflows.test.ts:538', text: '<@BOT> status', route: { kind: 'workflow_control', control: { kind: 'status' } } },
  { covers: 'slack-surface-workflows.test.ts:548', text: '<@BOT> approve api', route: { kind: 'workflow_control', control: { kind: 'approve', task: 'api' } } },
  { covers: 'slack-surface-workflows.test.ts:565', text: '<@BOT> what did the api task change?', route: { kind: 'workflow_question', text: 'what did the api task change?' } },
  {
    covers: 'slack-surface-workflows.test.ts:601',
    text: '<@BOT> Can you help me figure out why that failed and execute a fix with claude?',
    route: { kind: 'workflow_question', text: 'Can you help me figure out why that failed and execute a fix with claude?' },
  },
  { covers: 'slack-surface-workflows.test.ts:662', text: '<@BOT> how are we doing', route: { kind: 'workflow_question', text: 'how are we doing' } },
  {
    covers: 'slack-surface-workflows.test.ts:855',
    text: '<@BOT> why do we get extra merge stacks when we babysit landing these workflows?',
    route: { kind: 'workflow_question', text: 'why do we get extra merge stacks when we babysit landing these workflows?' },
  },
  { covers: 'slack-do1-ux-command-error.e2e.test.ts:87', text: '<@UBOT> approve hello', route: { kind: 'workflow_control', control: { kind: 'approve', task: 'hello' } } },
  { covers: 'slack-do1-ux-non-lobby-mention.e2e.test.ts:90', text: '<@UBOT> can you help?', route: { kind: 'workflow_question', text: 'can you help?' } },
  { covers: 'no Slack test (empty-text branch)', text: '<@UBOT>', route: { kind: 'workflow_help' } },
];

describe('mention router — workflow-bound channel routes match the Slack suite', () => {
  it.each(WORKFLOW_CASES)('$covers: "$text"', (c) => {
    expect(routeWorkflowMention(c.text)).toEqual(c.route);
  });
});
