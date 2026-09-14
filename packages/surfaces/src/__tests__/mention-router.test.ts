import { describe, it, expect, vi } from 'vitest';
import { routePlanningMention, routeRepoScopedMention, routeWorkflowMention } from '../core/mention-router.js';
import type { PlanningMentionRoute, RepoScopedMentionRoute, WorkflowMentionRoute } from '../core/mention-router.js';
import type { PlanDraftRecord } from '../approval/chat-transport.js';

vi.mock('@slack/bolt', () => {
  throw new Error('@slack/bolt was loaded by the transport-agnostic mention router');
});

const PRESET_KEYS = ['cursor+claude', 'cursor+codex', 'omp+claude', 'omp+codex', 'omp', 'codex', 'claude'];
const DEFAULT_PRESET = 'codex';
const ALL_WORKFLOWS_STATUS = { operation: 'status', target: { all: true } } as const;

interface WorkflowCase {
  covers: string;
  text: string;
  route: WorkflowMentionRoute;
}

interface PlanningCase {
  covers: string;
  text: string;
  userId?: string | null;
  presetKeys?: string[];
  defaultPreset?: string;
  readyDraftRequestedBy?: string;
  pendingConfirm?: boolean;
  nonLobby?: boolean;
  route: PlanningMentionRoute;
  announceAutoSubmitUnavailable?: boolean;
  scoped?: RepoScopedMentionRoute;
}

function draftRequestedBy(requestedBy: string): PlanDraftRecord {
  return { draftId: 'draft-1', requestedBy } as PlanDraftRecord;
}

function routeLobby(c: PlanningCase) {
  const draft = c.readyDraftRequestedBy ? draftRequestedBy(c.readyDraftRequestedBy) : undefined;
  const planning = routePlanningMention(
    { text: c.text, userId: c.userId === null ? undefined : (c.userId ?? 'U1') },
    { presetKeys: c.presetKeys ?? PRESET_KEYS, defaultPresetKey: c.defaultPreset ?? DEFAULT_PRESET, readyDraft: () => draft },
  );
  const scoped = planning.route.kind === 'resolve_repo'
    ? routeRepoScopedMention(planning.parsed, {
      allowsLobbyControls: !c.nonLobby,
      hasPendingConfirm: () => Boolean(c.pendingConfirm),
    })
    : undefined;
  return { planning, scoped };
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

const PLANNING_CASES: PlanningCase[] = [
  // unknown preset, greeting, explicit /plan, channel repo setup
  {
    covers: 'no Slack test (unknown-preset branch)',
    text: '<@BOT> [cursor+gpt] add a /health endpoint',
    route: { kind: 'unknown_preset', preset: 'cursor+gpt' },
  },
  { covers: 'slack-thread-isolation.test.ts:316', text: '<@UBOT123>', route: { kind: 'greeting' } },
  { covers: 'slack-approve-button-repros.e2e.test.ts:223', text: '<@UBOT> /plan', route: { kind: 'explicit_plan' } },
  { covers: 'slack-surface.test.ts:626', text: '<@U_BOT> /plan', userId: null, route: { kind: 'explicit_plan' } },
  { covers: 'slack-plan-intent-monkey.e2e.test.ts:235', text: '<@UBOT> /plan', pendingConfirm: true, route: { kind: 'explicit_plan' } },
  { covers: 'slack-plan-submission-repros.e2e.test.ts:457', text: '<@UBOT> /plan', readyDraftRequestedBy: 'U_PROOF', userId: 'U_PROOF', route: { kind: 'explicit_plan' } },
  {
    covers: 'slack-surface-workflows.test.ts:1285',
    text: '<@BOT> set up #invoker-repo https://github.com/Neko-Catpital-Labs/Invoker and #rips-clone-mobile-repo https://github.com/EdbertChan/notarepo',
    route: {
      kind: 'channel_repo_setup',
      pairs: [
        { channelName: 'invoker-repo', repoUrl: 'https://github.com/Neko-Catpital-Labs/Invoker' },
        { channelName: 'rips-clone-mobile-repo', repoUrl: 'https://github.com/EdbertChan/notarepo' },
      ],
    },
  },
  {
    covers: 'slack-surface-workflows.test.ts:1365',
    text: '<@BOT> map #invoker-repo to https://github.com/Neko-Catpital-Labs/Invoker',
    route: { kind: 'channel_repo_setup', pairs: [{ channelName: 'invoker-repo', repoUrl: 'https://github.com/Neko-Catpital-Labs/Invoker' }] },
  },
  {
    covers: 'slack-surface-workflows.test.ts:1397',
    text: '<@BOT> setup #invoker-repo https://github.com/Neko-Catpital-Labs/Invoker #rips-clone-mobile-repo https://github.com/EdbertChan/notarepo',
    route: {
      kind: 'channel_repo_setup',
      pairs: [
        { channelName: 'invoker-repo', repoUrl: 'https://github.com/Neko-Catpital-Labs/Invoker' },
        { channelName: 'rips-clone-mobile-repo', repoUrl: 'https://github.com/EdbertChan/notarepo' },
      ],
    },
  },
  {
    covers: 'slack-surface-workflows.test.ts:1335',
    text: '<@BOT> set up #invoker-repo https://github.com/Neko-Catpital-Labs/Invoker and #rips-clone-mobile-repo https://github.com/EdbertChan/notarepo',
    userId: 'U_INTRUDER',
    route: {
      kind: 'channel_repo_setup',
      pairs: [
        { channelName: 'invoker-repo', repoUrl: 'https://github.com/Neko-Catpital-Labs/Invoker' },
        { channelName: 'rips-clone-mobile-repo', repoUrl: 'https://github.com/EdbertChan/notarepo' },
      ],
    },
  },
  {
    covers: 'slack-surface-workflows.test.ts:1556',
    text: '<@BOT> bind #old-invoker-repo to https://github.com/Neko-Catpital-Labs/Invoker',
    route: { kind: 'channel_repo_setup', pairs: [{ channelName: 'old-invoker-repo', repoUrl: 'https://github.com/Neko-Catpital-Labs/Invoker' }] },
  },

  // ready-draft submission
  {
    covers: 'slack-plan-submission-repros.e2e.test.ts:351',
    text: '<@UBOT> submit it',
    userId: 'U_PROOF',
    readyDraftRequestedBy: 'U_PROOF',
    route: { kind: 'submit_ready_draft', draft: draftRequestedBy('U_PROOF'), userId: 'U_PROOF' },
  },
  {
    covers: 'no Slack test (another user submits a ready draft)',
    text: '<@UBOT> submit it',
    userId: 'U_OTHER',
    readyDraftRequestedBy: 'U_PROOF',
    route: { kind: 'submit_denied' },
  },
  {
    covers: 'no Slack test (a ready draft submitted with no user)',
    text: '<@UBOT> submit to invoker',
    userId: null,
    readyDraftRequestedBy: 'U_PROOF',
    route: { kind: 'submit_denied' },
  },
  {
    covers: 'slack-plan-intent-auto-detect-repros.e2e.test.ts:194',
    text: '<@UBOT> submit it',
    userId: 'U_TEST',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'submit it', explicitLocalAgent: false },
  },
  {
    covers: 'slack-plan-submission-repros.e2e.test.ts:486',
    text: '<@UBOT> please try again',
    userId: 'U_PROOF',
    readyDraftRequestedBy: 'U_PROOF',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'please try again', explicitLocalAgent: false },
  },

  // pending confirmation
  {
    covers: 'slack-plan-intent-monkey.e2e.test.ts:227',
    text: '<@UBOT> actually never mind',
    pendingConfirm: true,
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'confirm_reply' },
  },
  {
    covers: 'slack-plan-intent-monkey.e2e.test.ts:227',
    text: '<@UBOT> submit it',
    pendingConfirm: true,
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'confirm_reply' },
  },
  {
    covers: 'no Slack test (a mention outside the lobby resolves a pending confirmation)',
    text: '<@UBOT> yes',
    pendingConfirm: true,
    nonLobby: true,
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'confirm_reply' },
  },
  {
    covers: 'slack-plan-intent-auto-detect-repros.e2e.test.ts:394',
    text: '<@UBOT> actually never mind',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'actually never mind', explicitLocalAgent: false },
  },
  {
    covers: 'slack-terminal-parity.e2e.test.ts:210',
    text: '<@UBOT> yes',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'yes', explicitLocalAgent: false },
  },

  // lobby operations
  {
    covers: 'slack-surface-workflows.test.ts:873',
    text: '<@BOT> recreate all workflows',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'workflow_op', op: { operation: 'recreate', target: { all: true } } },
  },
  {
    covers: 'slack-surface-workflows.test.ts:892',
    text: '<@BOT> recreate all',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'workflow_op', op: { operation: 'recreate', target: { all: true } } },
  },
  {
    covers: 'slack-surface-workflows.test.ts:1097',
    text: '<@BOT> retry wf-123',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'workflow_op', op: { operation: 'retry', target: { workflow: 'wf-123' } } },
  },
  {
    covers: 'slack-surface-workflows.test.ts:1108',
    text: '<@BOT> status',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'workflow_op', op: ALL_WORKFLOWS_STATUS },
  },
  { covers: 'slack-surface-workflows.test.ts:1030', text: '<@BOT> restart', route: { kind: 'resolve_repo' }, scoped: { kind: 'restart' } },
  {
    covers: 'slack-surface-workflows.test.ts:1049',
    text: '<@BOT> restart',
    nonLobby: true,
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'control_rejected' },
  },
  {
    covers: 'slack-surface-workflows.test.ts:1059',
    text: '<@BOT> recreate all',
    nonLobby: true,
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'control_rejected' },
  },
  {
    covers: 'slack-surface-workflows.test.ts:1152',
    text: '<@BOT> how many workflows are running?',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'workflow_op', op: ALL_WORKFLOWS_STATUS },
  },
  {
    covers: 'slack-surface-workflows.test.ts:1951',
    text: '<@BOT> run local: report back how many workflows we are running',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'workflow_op', op: ALL_WORKFLOWS_STATUS },
  },

  // local commands
  {
    covers: 'slack-surface-workflows.test.ts:1933',
    text: '<@BOT> exec local: pnpm test -- --run',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'local_command', request: { kind: 'command', text: 'pnpm test -- --run' } },
  },
  {
    covers: 'slack-surface-workflows.test.ts:2001',
    text: '<@BOT> exec local: cat /etc/passwd',
    userId: 'U_ATTACKER',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'local_command', request: { kind: 'command', text: 'cat /etc/passwd' } },
  },
  {
    covers: 'slack-surface-workflows.test.ts:2029',
    text: '<@BOT> [repo:foo] exec local: pnpm test',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'local_command', request: { kind: 'command', text: 'pnpm test' } },
  },

  // plan intent
  {
    covers: 'slack-plan-intent-confirm-repros.e2e.test.ts:181',
    text: '<@UBOT> /plan change the theme to Pink/Yellow',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'plan_intent', requestText: 'change the theme to Pink/Yellow' },
  },
  {
    covers: 'slack-plan-intent-confirm-repros.e2e.test.ts:148',
    text: '<@UBOT> /plan lets change the theme to Pink/Yellow for https://github.com/EdbertChan/notarepo',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'plan_intent', requestText: 'lets change the theme to Pink/Yellow for https://github.com/EdbertChan/notarepo' },
  },
  {
    covers: 'slack-plan-intent-confirm-repros.e2e.test.ts:273',
    text: '<@UBOT> /plan actually add feature B instead',
    pendingConfirm: true,
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'plan_intent', requestText: 'actually add feature B instead' },
  },

  // conversation turns
  {
    covers: 'slack-plan-submission-repros.e2e.test.ts:315',
    text: '<@UBOT> [auto-submit] build this draft',
    route: { kind: 'resolve_repo' },
    announceAutoSubmitUnavailable: true,
    scoped: { kind: 'conversation_turn', requestText: 'build this draft', explicitLocalAgent: false },
  },
  {
    covers: 'slack-plan-submission-repros.e2e.test.ts:292',
    text: '<@UBOT> cancel this draft',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'cancel this draft', explicitLocalAgent: false },
  },
  {
    covers: 'slack-plan-submission-repros.e2e.test.ts:392',
    text: '<@UBOT> [special] [repo:proof] preserve this context',
    presetKeys: [...PRESET_KEYS, 'special'],
    defaultPreset: 'special',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'preserve this context', explicitLocalAgent: false },
  },
  {
    covers: 'slack-plan-intent-real-thread-repro.e2e.test.ts:260',
    text: '<@UBOT> convert this to Invoker',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'convert this to Invoker', explicitLocalAgent: false },
  },
  {
    covers: 'slack-do1-ux-stuck-ack.e2e.test.ts:144',
    text: '<@UBOT123456> plan:',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'plan:', explicitLocalAgent: false },
  },
  {
    covers: 'slack-surface.test.ts:149',
    text: '<@U_BOT> hello',
    nonLobby: true,
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'hello', explicitLocalAgent: false },
  },
  {
    covers: 'slack-surface.test.ts:836',
    text: '<@U_BOT> [repo:notarepo] plan: add a health endpoint',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'plan: add a health endpoint', explicitLocalAgent: false },
  },
  {
    covers: 'slack-multi-thread-channel-isolation.e2e.test.ts:142',
    text: '<@U_BOT> 1. Yes 2. Skip 3. Ignore the stacked ones 4. Do not delete',
    nonLobby: true,
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: '1. Yes 2. Skip 3. Ignore the stacked ones 4. Do not delete', explicitLocalAgent: false },
  },
  {
    covers: 'slack-surface-workflows.test.ts:1303',
    text: '<@BOT> plan: harden routing',
    nonLobby: true,
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'plan: harden routing', explicitLocalAgent: false },
  },
  {
    covers: 'slack-surface-workflows.test.ts:1533',
    text: '<@BOT> continue planning',
    nonLobby: true,
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'continue planning', explicitLocalAgent: false },
  },
  {
    covers: 'slack-surface-workflows.test.ts:1236',
    text: '<@BOT> add a /health endpoint to https://github.com/openai/invoker',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'add a /health endpoint to https://github.com/openai/invoker', explicitLocalAgent: false },
  },
  {
    covers: 'slack-surface-workflows.test.ts:1589',
    text: '<@BOT> [repo:foo] plan: add a /health endpoint to https://github.com/openai/invoker',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'plan: add a /health endpoint to https://github.com/openai/invoker', explicitLocalAgent: false },
  },
  {
    covers: 'slack-surface-workflows.test.ts:1635',
    text: '<@BOT> plan: fix the issue at https://github.com/openai/invoker/pull/123',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'plan: fix the issue at https://github.com/openai/invoker/pull/123', explicitLocalAgent: false },
  },
  {
    covers: 'slack-surface-workflows.test.ts:1662',
    text: '<@BOT> local: start in the current repo',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'start in the current repo', explicitLocalAgent: true },
  },
  {
    covers: 'slack-surface-workflows.test.ts:1070',
    text: '<@BOT> draft a plan for a health endpoint',
    nonLobby: true,
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'draft a plan for a health endpoint', explicitLocalAgent: false },
  },
  {
    covers: 'slack-surface-workflows.test.ts:1118',
    text: '<@BOT> can you recreate everything please',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'can you recreate everything please', explicitLocalAgent: false },
  },
  {
    covers: 'slack-surface-workflows.test.ts:1164',
    text: '<@BOT> add a /health endpoint',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'add a /health endpoint', explicitLocalAgent: false },
  },
  {
    covers: 'slack-surface-workflows.test.ts:1174',
    text: '<@BOT> lets change the theme of the app from black to pink',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'lets change the theme of the app from black to pink', explicitLocalAgent: false },
  },
  {
    covers: 'slack-surface-workflows.test.ts:1185',
    text: '<@BOT> local: reproduce the flaky test',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'reproduce the flaky test', explicitLocalAgent: true },
  },
  {
    covers: 'slack-surface-workflows.test.ts:1964',
    text: '<@BOT> local: fix the Slack routing bug',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'fix the Slack routing bug', explicitLocalAgent: true },
  },
  {
    covers: 'slack-surface-workflows.test.ts:1195',
    text: '<@BOT> plan: add a /health endpoint',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'plan: add a /health endpoint', explicitLocalAgent: false },
  },
  {
    covers: 'slack-surface-workflows.test.ts:291',
    text: '<@BOT> [cursor+codex] add a /health endpoint',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'add a /health endpoint', explicitLocalAgent: false },
  },
  {
    covers: 'slack-surface-workflows.test.ts:1212',
    text: '<@BOT> plan this in <https://github.com/EdbertChan/notarepo/|notarepo>',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'plan this in <https://github.com/EdbertChan/notarepo/|notarepo>', explicitLocalAgent: false },
  },
  {
    covers: 'slack-surface-workflows.test.ts:1260',
    text: '<@BOT> plan https://github.com/example/one and https://github.com/example/two',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'plan https://github.com/example/one and https://github.com/example/two', explicitLocalAgent: false },
  },
  {
    covers: 'slack-surface-workflows.test.ts:1503',
    text: '<@BOT> [repo:mobile] plan: add mobile behavior',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'plan: add mobile behavior', explicitLocalAgent: false },
  },
  {
    covers: 'slack-surface-workflows.test.ts:1609',
    text: '<@BOT> [repo:https://www.onorca.dev] plan: add a /health endpoint',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'plan: add a /health endpoint', explicitLocalAgent: false },
  },
  {
    covers: 'slack-surface-workflows.test.ts:1805',
    text: '<@BOT> local: continue in https://gitlab.com/openai/invoker.git',
    route: { kind: 'resolve_repo' },
    scoped: { kind: 'conversation_turn', requestText: 'continue in https://gitlab.com/openai/invoker.git', explicitLocalAgent: true },
  },
];

describe('mention router — workflow-bound channel routes match the Slack suite', () => {
  it.each(WORKFLOW_CASES)('$covers: "$text"', (c) => {
    expect(routeWorkflowMention(c.text)).toEqual(c.route);
  });
});

describe('mention router — lobby routes match the Slack suite', () => {
  it.each(PLANNING_CASES)('$covers: "$text"', (c) => {
    const { planning, scoped } = routeLobby(c);
    expect(planning.route).toEqual(c.route);
    expect(planning.announceAutoSubmitUnavailable).toBe(c.announceAutoSubmitUnavailable ?? false);
    expect(scoped).toEqual(c.scoped);
  });
});

describe('mention router — lazy facts', () => {
  it('does not look up a ready draft for routes decided before the submit check', () => {
    for (const text of ['<@UBOT>', '<@UBOT> [cursor+gpt] go', '<@UBOT> /plan', '<@BOT> map #repo to https://github.com/a/b']) {
      const readyDraft = vi.fn(() => undefined);
      routePlanningMention({ text, userId: 'U1' }, { presetKeys: PRESET_KEYS, defaultPresetKey: DEFAULT_PRESET, readyDraft });
      expect(readyDraft).not.toHaveBeenCalled();
    }
  });

  it('does not consult the pending confirmation for a `/plan <text>` request', () => {
    const hasPendingConfirm = vi.fn(() => true);
    const { parsed } = routePlanningMention(
      { text: '<@UBOT> /plan add feature B', userId: 'U1' },
      { presetKeys: PRESET_KEYS, defaultPresetKey: DEFAULT_PRESET, readyDraft: () => undefined },
    );
    expect(routeRepoScopedMention(parsed, { allowsLobbyControls: true, hasPendingConfirm })).toEqual({ kind: 'plan_intent', requestText: 'add feature B' });
    expect(hasPendingConfirm).not.toHaveBeenCalled();
  });
});
