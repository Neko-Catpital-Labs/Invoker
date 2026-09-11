import {
  AttachmentBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  ComponentType,
  Events,
  GatewayIntentBits,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits,
  ThreadAutoArchiveDuration,
  type APIActionRowComponent,
  type APIButtonComponentWithCustomId,
  type Channel,
  type Guild,
  type Interaction,
  type Message,
} from 'discord.js';
import type {
  DiscordButton,
  DiscordGateway,
  DiscordGatewayHandlers,
  DiscordMessageEvent,
  DiscordMessagePayload,
  PrivateChannelRequest,
  SentMessage,
  SlashCommandDefinition,
} from './gateway.js';
import { DISCORD_MESSAGE_LIMIT } from './gateway.js';

export interface DiscordJsGatewayOptions {
  token: string;
  commandGuildIds?: string[];
  client?: Client;
  onHandlerError?: (error: unknown) => void;
}

const BUTTON_STYLES: Record<DiscordButton['style'], ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  danger: ButtonStyle.Danger,
};

const BUTTONS_PER_ROW = 5;

type MessageLike = Pick<Message, 'id' | 'channelId' | 'guildId' | 'content'> & {
  author: { id: string; bot: boolean };
  channel: { isThread(): boolean; parentId?: string | null };
  mentions: { users: { has(id: string): boolean } };
};

export function toMessageEvent(message: MessageLike, botUserId: string): DiscordMessageEvent {
  return {
    id: message.id,
    channelId: message.channelId,
    parentChannelId: message.channel.isThread() ? message.channel.parentId ?? undefined : undefined,
    guildId: message.guildId ?? undefined,
    authorId: message.author.id,
    authorIsBot: message.author.bot,
    content: message.content,
    mentionsBot: message.mentions.users.has(botUserId),
  };
}

export function toActionRows(buttons: DiscordButton[]): APIActionRowComponent<APIButtonComponentWithCustomId>[] {
  const rows: APIActionRowComponent<APIButtonComponentWithCustomId>[] = [];
  for (let start = 0; start < buttons.length; start += BUTTONS_PER_ROW) {
    rows.push({
      type: ComponentType.ActionRow,
      components: buttons.slice(start, start + BUTTONS_PER_ROW).map((button) => ({
        type: ComponentType.Button,
        custom_id: button.customId,
        label: button.label,
        style: BUTTON_STYLES[button.style] as APIButtonComponentWithCustomId['style'],
      })),
    });
  }
  return rows;
}

function parentOf(channel: Channel | null): string | undefined {
  return channel?.isThread() ? channel.parentId ?? undefined : undefined;
}

export class DiscordJsGateway implements DiscordGateway {
  readonly maxMessageLength = DISCORD_MESSAGE_LIMIT;
  private readonly client: Client;
  private botUserId = '';

  constructor(private readonly options: DiscordJsGatewayOptions) {
    this.client = options.client ?? new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
  }

  async connect(handlers: DiscordGatewayHandlers): Promise<{ botUserId: string }> {
    this.client.on(Events.MessageCreate, (message) => {
      this.run(() => handlers.onMessage(toMessageEvent(message, this.botUserId)));
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      this.run(() => this.dispatchInteraction(interaction, handlers));
    });
    const ready = new Promise<void>((resolve) => this.client.once(Events.ClientReady, () => resolve()));
    await this.client.login(this.options.token);
    await ready;
    this.botUserId = this.client.user?.id ?? '';
    return { botUserId: this.botUserId };
  }

  async disconnect(): Promise<void> {
    await this.client.destroy();
  }

  async startThread(channelId: string, messageId: string, name: string): Promise<string> {
    const message = await this.fetchMessage(channelId, messageId);
    if (message.hasThread && message.thread) return message.thread.id;
    const thread = await message.startThread({ name: name.slice(0, 100), autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek });
    return thread.id;
  }

  async send(channelId: string, payload: DiscordMessagePayload): Promise<SentMessage> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isSendable()) throw new Error(`Discord channel ${channelId} does not accept messages.`);
    const sent = await channel.send({
      content: payload.content,
      components: toActionRows(payload.buttons ?? []),
      files: (payload.files ?? []).map((file) => new AttachmentBuilder(Buffer.from(file.content, 'utf8'), { name: file.name })),
      allowedMentions: { parse: [] },
    });
    return { id: sent.id };
  }

  async edit(channelId: string, messageId: string, payload: DiscordMessagePayload): Promise<void> {
    const message = await this.fetchMessage(channelId, messageId);
    await message.edit({
      content: payload.content,
      components: toActionRows(payload.buttons ?? []),
      allowedMentions: { parse: [] },
    });
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    await (await this.fetchMessage(channelId, messageId)).react(emoji);
  }

  async unreact(channelId: string, messageId: string, emoji: string): Promise<void> {
    const message = await this.fetchMessage(channelId, messageId);
    await message.reactions.cache.get(emoji)?.users.remove(this.botUserId);
  }

  async createPrivateChannel(request: PrivateChannelRequest): Promise<string> {
    const guild = await this.resolveGuild(request);
    const memberAccess = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
    const existing = guild.channels.cache.find((channel) => channel.type === ChannelType.GuildText && channel.name === request.name);
    if (existing && existing.type === ChannelType.GuildText) {
      for (const memberId of request.memberIds) {
        await existing.permissionOverwrites.edit(memberId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }, { type: OverwriteType.Member });
      }
      return existing.id;
    }
    const created = await guild.channels.create({
      name: request.name,
      type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
        { id: this.botUserId, type: OverwriteType.Member, allow: [...memberAccess, PermissionFlagsBits.AttachFiles] },
        ...request.memberIds.map((id) => ({ id, type: OverwriteType.Member, allow: memberAccess })),
      ],
    });
    return created.id;
  }

  async registerCommands(commands: SlashCommandDefinition[]): Promise<void> {
    const guildIds = this.options.commandGuildIds ?? [];
    for (const command of commands) {
      if (!guildIds.length) {
        await this.client.application?.commands.create(command);
        continue;
      }
      for (const guildId of guildIds) {
        await (await this.client.guilds.fetch(guildId)).commands.create(command);
      }
    }
  }

  private async dispatchInteraction(interaction: Interaction, handlers: DiscordGatewayHandlers): Promise<void> {
    if (interaction.isButton()) {
      await handlers.onButton({
        customId: interaction.customId,
        channelId: interaction.channelId,
        parentChannelId: parentOf(interaction.channel),
        messageId: interaction.message.id,
        userId: interaction.user.id,
        acknowledge: async () => { await interaction.deferUpdate(); },
        notify: async (text) => { await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral }); },
      });
      return;
    }
    if (interaction.isChatInputCommand()) {
      await handlers.onCommand({
        name: interaction.commandName,
        channelId: interaction.channelId,
        parentChannelId: parentOf(interaction.channel),
        userId: interaction.user.id,
        acknowledge: async () => { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); },
        respond: async (text) => { await interaction.editReply({ content: text }); },
      });
    }
  }

  private async fetchMessage(channelId: string, messageId: string): Promise<Message> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) throw new Error(`Discord channel ${channelId} is not a text channel.`);
    return channel.messages.fetch(messageId);
  }

  private async resolveGuild(request: PrivateChannelRequest): Promise<Guild> {
    if (request.nearChannelId) {
      const channel = await this.client.channels.fetch(request.nearChannelId);
      if (channel && 'guild' in channel && channel.guild) return channel.guild;
    }
    if (request.guildId) return this.client.guilds.fetch(request.guildId);
    throw new Error('No Discord guild is known for this workflow channel.');
  }

  private run(task: () => Promise<void>): void {
    task().catch((error: unknown) => {
      if (this.options.onHandlerError) this.options.onHandlerError(error);
      else console.error('[discord] handler failed:', error);
    });
  }
}
