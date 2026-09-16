import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SQLiteAdapter, WorkflowChannelRepository } from '@invoker/data-store';
import {
  CHANNEL_REPO_SOURCE_PRECEDENCE,
  resolveChannelRepo,
  type ChannelRepoLookups,
} from '../channel-repo-resolver.js';

const CONFIG_REPO = 'https://github.com/acme/config-repo.git';
const BINDING_REPO = 'https://github.com/acme/binding-repo.git';
const TOPIC_REPO = 'https://github.com/acme/topic-repo.git';
const PURPOSE_REPO = 'https://github.com/acme/purpose-repo.git';

// ── Mock @slack/bolt so SlackSurface can be constructed without a network ──

const conversationsInfo = vi.fn();

vi.mock('@slack/bolt', () => {
  class MockApp {
    command = vi.fn();
    action = vi.fn();
    event = vi.fn();
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    client = {
      chat: { postMessage: vi.fn().mockResolvedValue({ ts: '1.1' }), update: vi.fn().mockResolvedValue({}) },
      auth: { test: vi.fn().mockResolvedValue({ user_id: 'U_BOT' }) },
      conversations: { info: (...args: unknown[]) => conversationsInfo(...args) },
    };
  }
  return { App: MockApp };
});

const { SlackSurface } = await import('../slack/slack-surface.js');

/**
 * The channel-default resolution that shipped before this resolver existed:
 * static config binding first, then the persisted channel binding, then nothing.
 */
function legacyResolveChannelDefaultRepoUrl(
  channelId: string | undefined,
  configBindings: Record<string, string>,
  persisted: Record<string, string>,
): string | undefined {
  if (!channelId) return undefined;
  const configured = configBindings[channelId];
  if (configured) return normalize(configured);
  const mapped = persisted[channelId];
  if (mapped) return normalize(mapped);
  return undefined;
}

function normalize(repoUrl: string): string {
  return repoUrl.trim().replace(/^<([^|>]+)(?:\|[^>]+)?>$/, '$1').replace(/\/+$/, '');
}

function lookupsFor(sources: {
  config?: string;
  binding?: string;
  topic?: string;
  purpose?: string;
  log?: ChannelRepoLookups['log'];
}): ChannelRepoLookups {
  return {
    configBinding: () => sources.config,
    persistedBinding: () => sources.binding,
    channelTopic: () => sources.topic,
    channelPurpose: () => sources.purpose,
    normalizeRepoUrl: normalize,
    log: sources.log,
  };
}

describe('resolveChannelRepo', () => {
  it('documents config > binding > topic > purpose as its precedence', () => {
    expect([...CHANNEL_REPO_SOURCE_PRECEDENCE]).toEqual(['config', 'binding', 'topic', 'purpose']);
  });

  it('returns nothing when the channel id is missing', async () => {
    const resolution = await resolveChannelRepo({ surface: 'slack' }, lookupsFor({ config: CONFIG_REPO }));
    expect(resolution).toEqual({ candidates: [], conflict: false });
  });

  it('returns nothing when no source answers', async () => {
    const resolution = await resolveChannelRepo({ surface: 'slack', channelId: 'C1' }, lookupsFor({}));
    expect(resolution.repoUrl).toBeUndefined();
    expect(resolution.conflict).toBe(false);
  });

  it('prefers the config binding over the persisted binding', async () => {
    const resolution = await resolveChannelRepo(
      { surface: 'slack', channelId: 'C1' },
      lookupsFor({ config: CONFIG_REPO, binding: BINDING_REPO }),
    );
    expect(resolution.repoUrl).toBe(CONFIG_REPO);
    expect(resolution.source).toBe('config');
  });

  it('falls back to the channel topic when no binding exists', async () => {
    const resolution = await resolveChannelRepo(
      { surface: 'slack', channelId: 'C1' },
      lookupsFor({ topic: `bugs go here ${TOPIC_REPO}` }),
    );
    expect(resolution.repoUrl).toBe(TOPIC_REPO);
    expect(resolution.source).toBe('topic');
    expect(resolution.conflict).toBe(false);
  });

  it('falls back to the channel purpose when the topic carries no url', async () => {
    const resolution = await resolveChannelRepo(
      { surface: 'slack', channelId: 'C1' },
      lookupsFor({ topic: 'no url here', purpose: `repo: ${PURPOSE_REPO}` }),
    );
    expect(resolution.repoUrl).toBe(PURPOSE_REPO);
    expect(resolution.source).toBe('purpose');
  });

  it('picks the config binding and logs both values when a topic url conflicts', async () => {
    const log = vi.fn();
    const resolution = await resolveChannelRepo(
      { surface: 'slack', channelId: 'C_CONFLICT' },
      lookupsFor({ config: CONFIG_REPO, topic: `see ${TOPIC_REPO}`, log }),
    );

    expect(resolution.repoUrl).toBe(CONFIG_REPO);
    expect(resolution.source).toBe('config');
    expect(resolution.conflict).toBe(true);
    expect(resolution.candidates).toEqual([
      { source: 'config', repoUrl: CONFIG_REPO },
      { source: 'topic', repoUrl: TOPIC_REPO },
    ]);

    expect(log).toHaveBeenCalledTimes(1);
    const [source, level, message] = log.mock.calls[0];
    expect(source).toBe('slack');
    expect(level).toBe('warn');
    expect(message).toContain('CHANNEL_REPO_CONFLICT');
    expect(message).toContain('C_CONFLICT');
    expect(message).toContain(CONFIG_REPO);
    expect(message).toContain(TOPIC_REPO);
    expect(message).toContain('config > binding > topic > purpose');
  });

  it('names every disagreeing source in the conflict log', async () => {
    const log = vi.fn();
    await resolveChannelRepo(
      { surface: 'slack', channelId: 'C_ALL' },
      lookupsFor({ config: CONFIG_REPO, binding: BINDING_REPO, topic: TOPIC_REPO, purpose: PURPOSE_REPO, log }),
    );
    const message = log.mock.calls[0][2];
    for (const repoUrl of [CONFIG_REPO, BINDING_REPO, TOPIC_REPO, PURPOSE_REPO]) {
      expect(message).toContain(repoUrl);
    }
  });

  it('does not log a conflict when every source agrees', async () => {
    const log = vi.fn();
    const resolution = await resolveChannelRepo(
      { surface: 'slack', channelId: 'C1' },
      lookupsFor({ config: CONFIG_REPO, binding: `${CONFIG_REPO}/`, topic: `docs ${CONFIG_REPO}`, log }),
    );
    expect(resolution.conflict).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it('keys lookups by surface and channel id', async () => {
    const seen: Array<{ surface: string; channelId: string }> = [];
    await resolveChannelRepo({ surface: 'discord', channelId: 'C_KEY' }, {
      configBinding: (key) => { seen.push({ ...key }); return undefined; },
      persistedBinding: (key) => { seen.push({ ...key }); return CONFIG_REPO; },
    });
    expect(seen).toEqual([
      { surface: 'discord', channelId: 'C_KEY' },
      { surface: 'discord', channelId: 'C_KEY' },
    ]);
  });

  it('treats a throwing lookup as no answer so a binding still resolves', async () => {
    const resolution = await resolveChannelRepo({ surface: 'slack', channelId: 'C1' }, {
      configBinding: () => CONFIG_REPO,
      channelTopic: () => { throw new Error('conversations.info unavailable'); },
      normalizeRepoUrl: normalize,
    });
    expect(resolution.repoUrl).toBe(CONFIG_REPO);
    expect(resolution.conflict).toBe(false);
  });
});

// ── Parity with the pre-resolver Slack behaviour ─────────────

const BINDING_WORKFLOW_PREFIX = '__slack_channel_repo__:';

interface BindingFixture {
  name: string;
  channelId: string | undefined;
  config: Record<string, string>;
  persisted: Record<string, string>;
}

const BINDING_FIXTURES: BindingFixture[] = [
  { name: 'no channel id', channelId: undefined, config: {}, persisted: {} },
  { name: 'config binding only', channelId: 'C_CFG', config: { C_CFG: CONFIG_REPO }, persisted: {} },
  { name: 'persisted binding only', channelId: 'C_DB', config: {}, persisted: { C_DB: BINDING_REPO } },
  {
    name: 'config binding wins over persisted binding',
    channelId: 'C_BOTH',
    config: { C_BOTH: CONFIG_REPO },
    persisted: { C_BOTH: BINDING_REPO },
  },
  {
    name: 'slack-escaped config url is unwrapped',
    channelId: 'C_ESC',
    config: { C_ESC: `<${CONFIG_REPO}|acme/config-repo>` },
    persisted: {},
  },
  { name: 'trailing slash is trimmed', channelId: 'C_SLASH', config: { C_SLASH: `${CONFIG_REPO}/` }, persisted: {} },
  { name: 'unbound channel', channelId: 'C_NONE', config: {}, persisted: {} },
];

async function buildSurface(config: Record<string, string>, persisted: Record<string, string>) {
  const adapter = await SQLiteAdapter.create(':memory:');
  const workflowChannelRepo = new WorkflowChannelRepository(adapter);
  for (const [channelId, repoUrl] of Object.entries(persisted)) {
    workflowChannelRepo.save({
      workflowId: `${BINDING_WORKFLOW_PREFIX}${channelId}`,
      channelId,
      repoUrl,
      createdAt: new Date().toISOString(),
    });
  }
  const surface = new SlackSurface({
    defaultRepoUrl: 'https://github.com/example/default-repo.git',
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    signingSecret: 'secret',
    channelRepoBindings: config,
    workflowChannelRepo,
    log: vi.fn(),
  });
  return { surface, adapter };
}

describe('SlackSurface.resolveChannelDefaultRepoUrl parity', () => {
  beforeEach(() => {
    conversationsInfo.mockReset();
    conversationsInfo.mockResolvedValue({ channel: {} });
  });

  for (const fixture of BINDING_FIXTURES) {
    it(`resolves the same repo as before for: ${fixture.name}`, async () => {
      const { surface, adapter } = await buildSurface(fixture.config, fixture.persisted);
      try {
        const resolved = await (surface as unknown as {
          resolveChannelDefaultRepoUrl(channelId: string | undefined): Promise<string | undefined>;
        }).resolveChannelDefaultRepoUrl(fixture.channelId);
        expect(resolved).toBe(legacyResolveChannelDefaultRepoUrl(fixture.channelId, fixture.config, fixture.persisted));
      } finally {
        adapter.close();
      }
    });
  }

  it('ignores a workflow channel mapping that is not a repo binding', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    const workflowChannelRepo = new WorkflowChannelRepository(adapter);
    workflowChannelRepo.save({
      workflowId: 'wf-not-a-binding',
      channelId: 'C_WF',
      repoUrl: BINDING_REPO,
      createdAt: new Date().toISOString(),
    });
    const surface = new SlackSurface({
      defaultRepoUrl: 'https://github.com/example/default-repo.git',
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'secret',
      workflowChannelRepo,
      log: vi.fn(),
    });
    try {
      const resolved = await (surface as unknown as {
        resolveChannelDefaultRepoUrl(channelId: string | undefined): Promise<string | undefined>;
      }).resolveChannelDefaultRepoUrl('C_WF');
      expect(resolved).toBeUndefined();
    } finally {
      adapter.close();
    }
  });

  it('logs the conflict and keeps the config binding when the channel topic disagrees', async () => {
    const log = vi.fn();
    const adapter = await SQLiteAdapter.create(':memory:');
    conversationsInfo.mockResolvedValue({ channel: { topic: { value: `bugs -> ${TOPIC_REPO}` } } });
    const surface = new SlackSurface({
      defaultRepoUrl: 'https://github.com/example/default-repo.git',
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'secret',
      channelRepoBindings: { C_CONFLICT: CONFIG_REPO },
      log,
    });
    try {
      const resolved = await (surface as unknown as {
        resolveChannelDefaultRepoUrl(channelId: string | undefined): Promise<string | undefined>;
      }).resolveChannelDefaultRepoUrl('C_CONFLICT');
      expect(resolved).toBe(CONFIG_REPO);
      const conflictLog = log.mock.calls.find((call) => String(call[2]).includes('CHANNEL_REPO_CONFLICT'));
      expect(conflictLog).toBeDefined();
      expect(conflictLog?.[1]).toBe('warn');
      expect(conflictLog?.[2]).toContain(CONFIG_REPO);
      expect(conflictLog?.[2]).toContain(TOPIC_REPO);
    } finally {
      adapter.close();
    }
  });

  it('adopts the channel topic repo when no binding exists', async () => {
    conversationsInfo.mockResolvedValue({ channel: { purpose: { value: `repo ${PURPOSE_REPO}` } } });
    const surface = new SlackSurface({
      defaultRepoUrl: 'https://github.com/example/default-repo.git',
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'secret',
      log: vi.fn(),
    });
    const resolved = await (surface as unknown as {
      resolveChannelDefaultRepoUrl(channelId: string | undefined): Promise<string | undefined>;
    }).resolveChannelDefaultRepoUrl('C_TOPIC');
    expect(resolved).toBe(PURPOSE_REPO);
  });

  it('reads channel metadata once per channel within the cache window', async () => {
    conversationsInfo.mockResolvedValue({ channel: { topic: { value: `repo ${TOPIC_REPO}` } } });
    const surface = new SlackSurface({
      defaultRepoUrl: 'https://github.com/example/default-repo.git',
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'secret',
      log: vi.fn(),
    });
    const resolve = (surface as unknown as {
      resolveChannelDefaultRepoUrl(channelId: string | undefined): Promise<string | undefined>;
    }).resolveChannelDefaultRepoUrl.bind(surface);

    expect(await resolve('C_CACHE')).toBe(TOPIC_REPO);
    expect(await resolve('C_CACHE')).toBe(TOPIC_REPO);
    expect(conversationsInfo).toHaveBeenCalledTimes(1);
  });

  it('falls back to no channel default when channel metadata cannot be read', async () => {
    conversationsInfo.mockRejectedValue(new Error('missing_scope'));
    const surface = new SlackSurface({
      defaultRepoUrl: 'https://github.com/example/default-repo.git',
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'secret',
      log: vi.fn(),
    });
    const resolved = await (surface as unknown as {
      resolveChannelDefaultRepoUrl(channelId: string | undefined): Promise<string | undefined>;
    }).resolveChannelDefaultRepoUrl('C_NOINFO');
    expect(resolved).toBeUndefined();
  });
});
