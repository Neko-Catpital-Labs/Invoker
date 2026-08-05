import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const surfacesMock = vi.hoisted(() => ({
  stageSlackPlanDraftForReview: vi.fn(async () => ({
    draftId: 'draft-1',
    version: 1,
    messageTs: 'posted',
    slackFileId: 'F1',
    status: 'ready',
    summary: { name: 'Scout bridge', steps: ['Inspect'], taskCount: 1, taskGroups: [{ workflow: null, tasks: ['Inspect'] }] },
  })),
  start: vi.fn(),
  SlackSurface: vi.fn(),
}));

vi.mock('@invoker/surfaces', () => {
  surfacesMock.SlackSurface.mockImplementation(() => ({
    start: surfacesMock.start,
    stageSlackPlanDraftForReview: surfacesMock.stageSlackPlanDraftForReview,
  }));
  return { SlackSurface: surfacesMock.SlackSurface };
}, { virtual: true });

describe('complaint scout bridge', () => {
  const savedEnv = { ...process.env };
  let managerDir: string;

  function restoreEnv(): void {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    restoreEnv();
    managerDir = mkdtempSync(path.join(tmpdir(), 'invoker-slack-scout-'));
    process.env.HOME = managerDir;
    process.env.INVOKER_SLACK_MANAGER_DIR = managerDir;
    process.env.INVOKER_REPO_ROOT = managerDir;
    process.env.INVOKER_REPO_URL = 'https://github.com/acme/repo.git';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_APP_TOKEN = 'xapp-test';
    process.env.SLACK_SIGNING_SECRET = 'secret';
    process.env.SLACK_CHANNEL_ID = 'C_DEFAULT';
  });

  afterEach(() => {
    restoreEnv();
    rmSync(managerDir, { recursive: true, force: true });
  });

  it('stages a plan draft through SlackSurface without starting Socket Mode', async () => {
    const { stageComplaintScoutPlanDraft } = await import('../complaint-scout-bridge.js');
    const planText = [
      'name: Scout bridge',
      'repoUrl: https://github.com/acme/repo.git',
      'onFinish: none',
      'tasks:',
      '  - id: inspect',
      '    description: Inspect the evidence-backed complaint',
      '    command: printf inspect',
      '    dependencies: []',
      '',
    ].join('\n');

    const result = await stageComplaintScoutPlanDraft({
      channelId: 'C_ALLOWED',
      threadTs: '1700000000.000100',
      planText,
      requestedBy: 'U0ALGQ64HMF',
    });

    expect(result.status).toBe('ready');
    expect(surfacesMock.start).not.toHaveBeenCalled();
    expect(surfacesMock.SlackSurface).toHaveBeenCalledWith(expect.objectContaining({
      botToken: 'xoxb-test',
      channelId: 'C_DEFAULT',
      slackPlanDraftRepo: expect.any(Object),
    }));
    expect(surfacesMock.stageSlackPlanDraftForReview).toHaveBeenCalledWith({
      channelId: 'C_ALLOWED',
      threadTs: '1700000000.000100',
      planText,
      repoUrl: 'https://github.com/acme/repo.git',
      harnessPreset: 'codex',
      workingDir: managerDir,
      requestedBy: 'U0ALGQ64HMF',
    });
  });
});
