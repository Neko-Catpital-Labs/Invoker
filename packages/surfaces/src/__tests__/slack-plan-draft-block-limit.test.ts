import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter, SlackPlanDraftRepository } from '@invoker/data-store';
import { SlackSurface } from '../slack/slack-surface.js';

vi.mock('@slack/bolt', () => {
  class MockApp {
    command = vi.fn();
    action = vi.fn();
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

describe('plan draft review card stays within Slack block text limits', () => {
  let adapter: SQLiteAdapter;
  let repo: SlackPlanDraftRepository;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    repo = new SlackPlanDraftRepository(adapter);
  });

  afterEach(() => adapter.close());

  it('clamps the section text to 3000 chars even when task descriptions are long', async () => {
    const longDescription = 'Goal: '.padEnd(3500, 'x');
    const planText = `name: Oversized plan\ntasks:\n  - id: a\n    description: "${longDescription}"\n`;

    const surface = new SlackSurface({
      botToken: 'xoxb', appToken: 'xapp', signingSecret: 's', channelId: 'CLOBBY',
      slackPlanDraftRepo: repo, log: () => {},
    });
    await surface.start(vi.fn() as never);

    await surface.stageSlackPlanDraftForReview({
      channelId: 'C1',
      threadTs: 'T1',
      planText,
      repoUrl: 'https://github.com/acme/repo.git',
      harnessPreset: 'codex',
      workingDir: '/tmp/repo',
      requestedBy: 'U1',
    });

    const app = surface.getApp() as any;
    const call = app.client.chat.postMessage.mock.calls[0][0];
    const sectionText: string = call.blocks[0].text.text;

    expect(sectionText.length).toBeLessThanOrEqual(3000);
  });
});
