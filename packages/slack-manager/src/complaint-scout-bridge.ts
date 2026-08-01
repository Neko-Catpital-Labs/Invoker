import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';

import { SlackSurface, type StageSlackPlanDraftResult } from '@invoker/surfaces';
import { SlackPlanDraftRepository, SQLiteAdapter } from '@invoker/data-store';

import { readSlackRuntimeConfig, resolveDefaultHarnessPreset } from './runtime-config.js';

export const REQUIRED_SLACK_ENV = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_CHANNEL_ID'];

export interface ComplaintScoutPlanDraftPayload {
  channelId: string;
  threadTs: string;
  planText: string;
  repoUrl?: string;
  workingDir?: string;
  harnessPreset?: string;
  requestedBy?: string;
}

export interface LoadSlackEnvResult {
  ownerEnvPath: string;
  missing: string[];
}

export function resolveSlackOwnerEnvPath(env: NodeJS.ProcessEnv = process.env): string {
  const legacyOwnerEnvPath = path.join(homedir(), '.invoker', '.slack-owner.env');
  const canonicalEnvPath = path.join(homedir(), '.invoker', '.env');
  return env.INVOKER_SLACK_OWNER_ENV
    ?? (existsSync(legacyOwnerEnvPath) ? legacyOwnerEnvPath : canonicalEnvPath);
}

export function loadSlackOwnerEnv(env: NodeJS.ProcessEnv = process.env): LoadSlackEnvResult {
  const ownerEnvPath = resolveSlackOwnerEnvPath(env);
  dotenv.config({ path: ownerEnvPath });
  return {
    ownerEnvPath,
    missing: REQUIRED_SLACK_ENV.filter((key) => !env[key]),
  };
}

export function readComplaintScoutPlanDraftPayload(filePath: string): ComplaintScoutPlanDraftPayload {
  const payload = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<ComplaintScoutPlanDraftPayload>;
  for (const key of ['channelId', 'threadTs', 'planText'] as const) {
    if (typeof payload[key] !== 'string' || !payload[key]?.trim()) {
      throw new Error(`Missing required ${key} in scout plan draft payload.`);
    }
  }
  return payload as ComplaintScoutPlanDraftPayload;
}

export async function stageComplaintScoutPlanDraft(payload: ComplaintScoutPlanDraftPayload): Promise<StageSlackPlanDraftResult> {
  const repoRoot = process.env.INVOKER_REPO_ROOT ?? process.cwd();
  const runtimeConfig = readSlackRuntimeConfig();
  const repoUrl = payload.repoUrl ?? process.env.INVOKER_REPO_URL ?? runtimeConfig.defaultRepoUrl;
  if (!repoUrl) throw new Error('Missing repoUrl for scout plan draft.');

  const managerHome = process.env.INVOKER_SLACK_MANAGER_DIR ?? path.join(homedir(), '.invoker', 'slack-manager');
  mkdirSync(managerHome, { recursive: true });
  const adapter = await SQLiteAdapter.create(path.join(managerHome, 'slack-manager.db'), { ownerCapability: true });
  try {
    const slackPlanDraftRepo = new SlackPlanDraftRepository(adapter);
    const defaultHarnessPreset = resolveDefaultHarnessPreset(process.env.INVOKER_SLACK_DEFAULT_PRESET, runtimeConfig.defaultHarnessPreset);
    const slack = new SlackSurface({
      botToken: process.env.SLACK_BOT_TOKEN!,
      appToken: process.env.SLACK_APP_TOKEN!,
      signingSecret: process.env.SLACK_SIGNING_SECRET!,
      channelId: process.env.SLACK_CHANNEL_ID!,
      lobbyChannelId: process.env.SLACK_LOBBY_CHANNEL_ID ?? process.env.SLACK_CHANNEL_ID,
      slackPlanDraftRepo,
      defaultRepoUrl: repoUrl,
      repoUrl,
      workingDir: payload.workingDir ?? repoRoot,
      defaultHarnessPreset,
      log: () => {},
    });
    return await slack.stageSlackPlanDraftForReview({
      channelId: payload.channelId,
      threadTs: payload.threadTs,
      planText: payload.planText,
      repoUrl,
      harnessPreset: payload.harnessPreset ?? defaultHarnessPreset ?? 'codex',
      workingDir: payload.workingDir ?? repoRoot,
      requestedBy: payload.requestedBy ?? 'slack-complaint-scout',
    });
  } finally {
    adapter.close();
  }
}

export async function runComplaintScoutDraftCommand(payloadFile: string): Promise<void> {
  const env = loadSlackOwnerEnv();
  if (env.missing.length > 0) {
    throw new Error(`Missing Slack credentials: ${env.missing.join(', ')} (looked in ${env.ownerEnvPath})`);
  }
  const payload = readComplaintScoutPlanDraftPayload(payloadFile);
  const result = await stageComplaintScoutPlanDraft(payload);
  console.log(JSON.stringify({
    ok: true,
    draftId: result.draftId,
    version: result.version,
    messageTs: result.messageTs,
    slackFileId: result.slackFileId,
    status: result.status,
    summary: result.summary,
  }));
}
