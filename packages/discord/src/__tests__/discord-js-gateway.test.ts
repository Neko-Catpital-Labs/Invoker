import { describe, expect, it } from 'vitest';
import { ButtonStyle, ComponentType } from 'discord.js';
import { toActionRows, toMessageEvent } from '../discord-js-gateway.js';

function message(overrides: { thread?: { parentId: string }; mentioned?: string[]; content?: string; guildId?: string | null }) {
  return {
    id: 'm1',
    channelId: overrides.thread ? 'thread-1' : 'general',
    guildId: overrides.guildId === undefined ? 'guild-1' : overrides.guildId,
    content: overrides.content ?? '<@bot> hello',
    author: { id: 'U1', bot: false },
    channel: { isThread: () => Boolean(overrides.thread), parentId: overrides.thread?.parentId ?? null },
    mentions: { users: { has: (id: string) => (overrides.mentioned ?? []).includes(id) } },
  };
}

describe('discord.js gateway mapping', () => {
  it('maps a top-level guild message without a parent channel', () => {
    expect(toMessageEvent(message({ mentioned: ['bot'] }), 'bot')).toEqual({
      id: 'm1',
      channelId: 'general',
      parentChannelId: undefined,
      guildId: 'guild-1',
      authorId: 'U1',
      authorIsBot: false,
      content: '<@bot> hello',
      mentionsBot: true,
    });
  });

  it('maps a thread message to its parent channel and keeps empty content as empty', () => {
    const event = toMessageEvent(message({ thread: { parentId: 'general' }, mentioned: ['bot'], content: '' }), 'bot');
    expect(event).toEqual(expect.objectContaining({ channelId: 'thread-1', parentChannelId: 'general', content: '', mentionsBot: true }));
  });

  it('does not treat a mention of someone else as a mention of the bot', () => {
    expect(toMessageEvent(message({ mentioned: ['U2'] }), 'bot').mentionsBot).toBe(false);
  });

  it('packs buttons into action rows of at most five with Discord styles', () => {
    const buttons = Array.from({ length: 6 }, (_, i) => ({ customId: `b${i}`, label: `B${i}`, style: i === 0 ? 'primary' as const : 'danger' as const }));
    const rows = toActionRows(buttons);
    expect(rows.map((row) => row.components.length)).toEqual([5, 1]);
    expect(rows[0]).toEqual(expect.objectContaining({ type: ComponentType.ActionRow }));
    expect(rows[0].components[0]).toEqual({ type: ComponentType.Button, custom_id: 'b0', label: 'B0', style: ButtonStyle.Primary });
    expect(rows[1].components[0].style).toBe(ButtonStyle.Danger);
  });
});
