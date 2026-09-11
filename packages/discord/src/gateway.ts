export const DISCORD_MESSAGE_LIMIT = 2000;

export type DiscordButtonStyle = 'primary' | 'secondary' | 'danger';

export interface DiscordButton {
  customId: string;
  label: string;
  style: DiscordButtonStyle;
}

export interface DiscordFile {
  name: string;
  content: string;
}

export interface DiscordMessagePayload {
  content: string;
  buttons?: DiscordButton[];
  files?: DiscordFile[];
}

export interface SentMessage {
  id: string;
}

export interface DiscordMessageEvent {
  id: string;
  channelId: string;
  parentChannelId?: string;
  guildId?: string;
  authorId: string;
  authorIsBot: boolean;
  content: string;
  mentionsBot: boolean;
}

export interface DiscordButtonEvent {
  customId: string;
  channelId: string;
  parentChannelId?: string;
  messageId: string;
  userId: string;
  acknowledge(): Promise<void>;
  notify(text: string): Promise<void>;
}

export interface DiscordCommandEvent {
  name: string;
  channelId: string;
  parentChannelId?: string;
  userId: string;
  acknowledge(): Promise<void>;
  respond(text: string): Promise<void>;
}

export interface DiscordGatewayHandlers {
  onMessage(event: DiscordMessageEvent): Promise<void>;
  onButton(event: DiscordButtonEvent): Promise<void>;
  onCommand(event: DiscordCommandEvent): Promise<void>;
}

export interface PrivateChannelRequest {
  name: string;
  memberIds: string[];
  nearChannelId?: string;
  guildId?: string;
}

export interface SlashCommandDefinition {
  name: string;
  description: string;
}

export interface DiscordGateway {
  readonly maxMessageLength: number;
  connect(handlers: DiscordGatewayHandlers): Promise<{ botUserId: string }>;
  disconnect(): Promise<void>;
  startThread(channelId: string, messageId: string, name: string): Promise<string>;
  send(channelId: string, payload: DiscordMessagePayload): Promise<SentMessage>;
  edit(channelId: string, messageId: string, payload: DiscordMessagePayload): Promise<void>;
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
  unreact(channelId: string, messageId: string, emoji: string): Promise<void>;
  createPrivateChannel(request: PrivateChannelRequest): Promise<string>;
  registerCommands(commands: SlashCommandDefinition[]): Promise<void>;
}
