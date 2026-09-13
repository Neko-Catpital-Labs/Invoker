import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter, SlackPlanDraftRepository } from '@invoker/data-store';
import { SlackSurface } from '../slack/slack-surface.js';
import type { SurfaceCommand } from '../surface.js';

interface MockHandler {
  pattern: string | RegExp;
  handler: Function;
}

vi.mock('@slack/bolt', () => {
  class MockApp {
    _actionHandlers: MockHandler[] = [];
    command = vi.fn();
    action = vi.fn((pattern: string | RegExp, handler: Function) => { this._actionHandlers.push({ pattern, handler }); });
    event = vi.fn();
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    client = {
      auth: { test: vi.fn().mockResolvedValue({ user_id: 'U_BOT' }) },
      chat: { postMessage: vi.fn().mockResolvedValue({ ts: '1.1' }), update: vi.fn().mockResolvedValue({}) },
      files: { uploadV2: vi.fn().mockResolvedValue({ ok: true, files: [{ ok: true, files: [{ id: 'F1' }] }] }) },
    };
  }
  return { App: MockApp };
});

function actionHandler(surface: InstanceType<typeof SlackSurface>, actionId: string): Function {
  const app = surface.getApp() as unknown as { _actionHandlers: MockHandler[] };
  return app._actionHandlers.find((h) => h.pattern === actionId)!.handler;
}

describe('approveSlackPlanDraft', () => {
  let adapter: SQLiteAdapter;
  let repo: SlackPlanDraftRepository;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    repo = new SlackPlanDraftRepository(adapter);
  });

  afterEach(() => adapter.close());

  function makeReadyDraft(planText: string) {
    const draft = repo.create({
      channelId: 'C1',
      threadTs: 'T1',
      planText,
      summaryJson: '{}',
      repoUrl: 'https://github.com/acme/repo.git',
      harnessPreset: 'codex',
      workingDir: '/tmp/repo',
      requestedBy: 'U1',
    });
    repo.bindMessage(draft, '123.456');
    repo.bindAttachment(draft, 'F1');
    repo.markReady(draft);
    return repo.get(draft.draftId, draft.version)!;
  }

  async function approve(onCommand: (command: SurfaceCommand) => Promise<{ workflowIds?: string[] } | void>, draft: ReturnType<typeof makeReadyDraft>) {
    const surface = new SlackSurface({
      botToken: 'xoxb', appToken: 'xapp', signingSecret: 's', channelId: 'CLOBBY',
      slackPlanDraftRepo: repo, log: () => {},
    });
    await surface.start(onCommand as never);
    const handler = actionHandler(surface, 'plan_draft_approve');
    const respond = vi.fn().mockResolvedValue(undefined);
    await handler({
      action: { type: 'button', value: `${draft.draftId}:${draft.version}` },
      body: { channel: { id: draft.channelId }, message: { thread_ts: draft.threadTs }, user: { id: 'U1' } },
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
    });
    return { respond };
  }

  it('passes the single workflowId from onCommand into markSubmitted', async () => {
    const draft = makeReadyDraft('name: Single\ntasks:\n  - id: a\n    description: A');
    const onCommand = vi.fn(async () => ({ workflowIds: ['wf-1'] }));

    await approve(onCommand, draft);

    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: 'start_plan',
      repoUrl: 'https://github.com/acme/repo.git',
      planText: expect.stringContaining('repoUrl: https://github.com/acme/repo.git'),
    }));
    const stored = repo.get(draft.draftId, draft.version);
    expect(stored?.status).toBe('submitted');
    expect(JSON.parse(stored?.workflowIdsJson ?? '[]')).toEqual(['wf-1']);
  });

  it('passes every workflowId from a stacked plan into markSubmitted', async () => {
    const draft = makeReadyDraft('name: Stack\nworkflows:\n  - name: A\n  - name: B\n');
    const onCommand = vi.fn(async () => ({ workflowIds: ['wf-stack-1', 'wf-stack-2'] }));

    await approve(onCommand, draft);

    const stored = repo.get(draft.draftId, draft.version);
    expect(stored?.status).toBe('submitted');
    expect(JSON.parse(stored?.workflowIdsJson ?? '[]')).toEqual(['wf-stack-1', 'wf-stack-2']);
  });

  it('falls back to an empty workflowIds list when onCommand returns nothing', async () => {
    const draft = makeReadyDraft('name: NoReturn\ntasks:\n  - id: a\n    description: A');
    const onCommand = vi.fn(async () => undefined);

    await approve(onCommand, draft);

    const stored = repo.get(draft.draftId, draft.version);
    expect(stored?.status).toBe('submitted');
    expect(JSON.parse(stored?.workflowIdsJson ?? '[]')).toEqual([]);
  });

  it('stages a ready plan review without submitting the child workflow', async () => {
    const surface = new SlackSurface({
      botToken: 'xoxb', appToken: 'xapp', signingSecret: 's', channelId: 'CLOBBY',
      slackPlanDraftRepo: repo, log: () => {},
    });
    const planText = [
      'name: Scout draft',
      'repoUrl: https://github.com/acme/repo.git',
      'onFinish: none',
      'tasks:',
      '  - id: investigate',
      '    description: Investigate the Slack complaint',
      '    command: printf scout',
      '    dependencies: []',
      '',
    ].join('\n');

    const result = await surface.stageSlackPlanDraftForReview({
      channelId: 'C1',
      threadTs: 'T1',
      planText,
      repoUrl: 'https://github.com/acme/repo.git',
      harnessPreset: 'codex',
      workingDir: '/tmp/repo',
      requestedBy: 'U1',
    });

    const app = surface.getApp() as any;
    const stored = repo.get(result.draftId, result.version);
    expect(stored?.status).toBe('ready');
    expect(stored?.confirmationMode).toBe('require');
    expect(stored?.planText).toBe(planText);
    expect(result.status).toBe('ready');
    expect(app.client.files.uploadV2).toHaveBeenCalledWith(expect.objectContaining({
      channel_id: 'C1',
      thread_ts: 'T1',
    }));
    expect(app.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'C1',
      blocks: expect.arrayContaining([
        expect.objectContaining({
          elements: expect.arrayContaining([
            expect.objectContaining({ action_id: 'plan_draft_approve' }),
            expect.objectContaining({ action_id: 'plan_draft_cancel' }),
          ]),
        }),
      ]),
    }));
  });
});
