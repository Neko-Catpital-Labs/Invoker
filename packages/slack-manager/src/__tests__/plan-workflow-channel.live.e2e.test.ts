import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SQLiteAdapter, WorkflowChannelRepository } from '@invoker/data-store';
import type { SurfaceEvent } from '@invoker/surfaces';
import { SlackSurface } from '../../../surfaces/src/slack/slack-surface.js';

const TEST_NAME = 'plan-workflow-channel.live.e2e.test.ts';
const REQUIRED_ENV = [
  'SLACK_BOT_TOKEN',
  'SLACK_LOBBY_CHANNEL_ID',
  'SLACK_TEST_REQUESTER_ID',
] as const;

const liveEnabled = process.env.INVOKER_E2E_SLACK_LIVE === '1';
const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
const liveConfigured = liveEnabled && missingEnv.length === 0;

if (!liveConfigured) {
  const reason = !liveEnabled
    ? 'set INVOKER_E2E_SLACK_LIVE=1 to opt in'
    : `missing ${missingEnv.join(', ')}`;
  console.log(`SKIPPED ${TEST_NAME}: ${reason}`);
}

interface SlackResponse {
  ok: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string };
}

interface SlackMessage {
  ts?: string;
  thread_ts?: string;
  text?: string;
}

interface SlackConversation {
  id?: string;
  name?: string;
  creator?: string;
  created?: number;
  is_private?: boolean;
  is_archived?: boolean;
}

interface LiveConfig {
  botToken: string;
  lobbyChannelId: string;
  requesterId: string;
}

function readLiveConfig(): LiveConfig | undefined {
  if (!liveConfigured) return undefined;
  return {
    botToken: process.env.SLACK_BOT_TOKEN!.trim(),
    lobbyChannelId: process.env.SLACK_LOBBY_CHANNEL_ID!.trim(),
    requesterId: process.env.SLACK_TEST_REQUESTER_ID!.trim(),
  };
}

function workflowProgress(workflowId: string, name: string): SurfaceEvent {
  return {
    type: 'workflow_progress',
    progress: {
      workflowId,
      name,
      percentComplete: 50,
      counts: { total: 2, completed: 1, failed: 0, closed: 0, running: 1, pending: 0 },
      tasks: [{ id: `${workflowId}/live-proof`, name: 'Live proof', status: 'running', phase: 'executing' }],
    },
  };
}

async function runLiveProof(config: LiveConfig): Promise<void> {
  const slackApi = async <T extends object>(method: string, body: Record<string, unknown>): Promise<T & SlackResponse> => {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.botToken}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
    const result = await response.json() as T & SlackResponse;
    if (!response.ok || !result.ok) {
      throw new Error(`Slack API ${method} failed: ${result.error ?? `HTTP ${response.status}`}`);
    }
    return result;
  };

  const listMessages = async (channel: string, oldest: string): Promise<SlackMessage[]> => {
    const messages: SlackMessage[] = [];
    let cursor: string | undefined;
    do {
      const result = await slackApi<{ messages?: SlackMessage[] }>('conversations.history', {
        channel,
        oldest,
        inclusive: true,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      messages.push(...(result.messages ?? []));
      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return messages;
  };

  const listMembers = async (channel: string): Promise<string[]> => {
    const members: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await slackApi<{ members?: string[] }>('conversations.members', {
        channel,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      members.push(...(result.members ?? []));
      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return members;
  };

  const adapter = await SQLiteAdapter.create(':memory:');
  const mappings = new WorkflowChannelRepository(adapter);
  const runId = `${Date.now().toString(36)}-${randomBytes(5).toString('hex')}`;
  const workflowId = `wf-live-${runId}`;
  const expectedChannelName = `workflow-live-${runId}`;
  const progressName = `Live route ${runId}`;
  const startedAtSeconds = (Date.now() / 1000).toFixed(6);
  const originText = (channelId: string) => `Created <#${channelId}> for workflow \`${workflowId}\`.`;
  const planText = [
    `name: Slack live proof ${runId}`,
    'scratch: true',
    'onFinish: none',
    'tasks:',
    '  - id: live-proof',
    '    description: Prove the production Slack workflow channel',
    '    command: echo live-proof',
    '    dependencies: []',
    '',
  ].join('\n');

  let createdChannelId: string | undefined;
  let originMessageTs: string | undefined;
  let exerciseError: unknown;
  const cleanupErrors: unknown[] = [];
  let archivedChannel: SlackConversation | undefined;

  try {
    const auth = await slackApi<{ user_id?: string }>('auth.test', {});
    expect(auth.user_id, 'auth.test must return the bot user ID').toBeTruthy();

    const surface = new SlackSurface({
      botToken: config.botToken,
      appToken: 'xapp-live-proof-not-used',
      signingSecret: 'live-proof-not-used',
      channelId: config.lobbyChannelId,
      lobbyChannelId: config.lobbyChannelId,
      workflowChannelRepo: mappings,
      log: () => {},
    });

    await surface.handleEvent({
      type: 'workflow_created',
      workflowId,
      requestedBy: config.requesterId,
      lobbyChannel: config.lobbyChannelId,
      planText,
    });

    const mapping = mappings.getByWorkflowId(workflowId);
    expect(mapping, 'SlackSurface must persist the created workflow channel').not.toBeNull();
    const mappedChannelId = mapping!.channelId;

    const channelInfo = await slackApi<{ channel?: SlackConversation }>('conversations.info', {
      channel: mappedChannelId,
    });
    const channelCreatedThisRun = channelInfo.channel?.id === mappedChannelId
      && channelInfo.channel.name === expectedChannelName
      && channelInfo.channel.creator === auth.user_id
      && channelInfo.channel.is_private === true
      && channelInfo.channel.is_archived === false
      && (channelInfo.channel.created ?? 0) >= Math.floor(Number(startedAtSeconds));
    if (channelCreatedThisRun) createdChannelId = mappedChannelId;
    expect(channelInfo.channel).toMatchObject({
      id: mappedChannelId,
      name: expectedChannelName,
      is_private: true,
      is_archived: false,
    });
    expect(channelInfo.channel?.creator).toBe(auth.user_id);
    expect(channelInfo.channel?.created).toBeGreaterThanOrEqual(Math.floor(Number(startedAtSeconds)));

    const members = await listMembers(mappedChannelId);
    expect([...new Set(members)].sort()).toEqual([...new Set([auth.user_id!, config.requesterId])].sort());

    await surface.handleEvent(workflowProgress(workflowId, progressName));

    const workflowMessages = await listMessages(mappedChannelId, startedAtSeconds);
    expect(workflowMessages.some((message) => message.text === `${progressName}: 50% (1/2)`)).toBe(true);
    expect(workflowMessages.some((message) => message.text?.includes(`Workflow \`${workflowId}\` is running here.`))).toBe(true);

    const lobbyMessages = await listMessages(config.lobbyChannelId, startedAtSeconds);
    const originMessages = lobbyMessages.filter((message) => message.text === originText(mappedChannelId));
    expect(originMessages).toHaveLength(1);
    expect(originMessages[0].thread_ts).toBeUndefined();
    expect(lobbyMessages.some((message) => message.text?.includes(progressName))).toBe(false);
    originMessageTs = originMessages[0].ts;
    expect(originMessageTs).toBeTruthy();
  } catch (error) {
    exerciseError = error;
  } finally {
    if (createdChannelId && !originMessageTs) {
      try {
        const lobbyMessages = await listMessages(config.lobbyChannelId, startedAtSeconds);
        originMessageTs = lobbyMessages.find((message) => message.text === originText(createdChannelId!))?.ts;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (originMessageTs) {
      try {
        await slackApi('chat.delete', { channel: config.lobbyChannelId, ts: originMessageTs });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (createdChannelId) {
      try {
        await slackApi('conversations.archive', { channel: createdChannelId });
        const archivedInfo = await slackApi<{ channel?: SlackConversation }>('conversations.info', {
          channel: createdChannelId,
        });
        archivedChannel = archivedInfo.channel;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    try {
      adapter.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (exerciseError || cleanupErrors.length > 0) {
    throw new AggregateError(
      [exerciseError, ...cleanupErrors].filter((error) => error !== undefined),
      'Live Slack workflow-channel proof or teardown failed',
    );
  }

  expect(archivedChannel).toMatchObject({
    id: createdChannelId,
    name: expectedChannelName,
    is_archived: true,
  });
}

describe.skipIf(!liveConfigured)('live Slack workflow-channel experience', () => {
  it('proves create, invite, routing, origin link, membership, and teardown against Slack', async () => {
    const config = readLiveConfig();
    if (!config) throw new Error('Live Slack test ran without all credential gates');

    try {
      await runLiveProof(config);
      console.log(`PASS ${TEST_NAME}: real Slack workflow channel verified and archived`);
    } catch (error) {
      console.error(`FAIL ${TEST_NAME}: real Slack workflow channel proof failed`);
      throw error;
    }
  }, 60_000);
});
