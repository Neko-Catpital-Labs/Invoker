import type {
  ChatTransport,
  CoreLogFn,
  FileUpload,
  MessageUpdate,
  OutboundMessage,
  PostResult,
  SayFn,
} from '@invoker/surfaces';
import type { DiscordFile, DiscordGateway, DiscordMessagePayload } from './gateway.js';
import { DiscordAction, chunkMessage, describeButtons, parseButtonId, toDiscordPayload } from './discord-rendering.js';

function carriesApproveButton(payload: DiscordMessagePayload): boolean {
  return (payload.buttons ?? []).some((button) => parseButtonId(button.customId).action === DiscordAction.planDraftApprove);
}

export class DiscordChatTransport implements ChatTransport {
  private readonly stagedReviewFiles = new Map<string, DiscordFile>();

  constructor(
    private readonly gateway: DiscordGateway,
    private readonly log: CoreLogFn,
  ) {}

  async post(channel: string, message: OutboundMessage): Promise<PostResult> {
    const chunks = message.blocks?.length ? [] : chunkMessage(message.text, this.gateway.maxMessageLength);
    if (chunks.length > 1) {
      const [first, ...rest] = chunks;
      const sent = await this.gateway.send(channel, { content: first });
      for (const chunk of rest) await this.gateway.send(channel, { content: chunk });
      return { ts: sent.id };
    }
    const payload = toDiscordPayload(message.text, message.blocks, this.gateway.maxMessageLength);
    const file = carriesApproveButton(payload) ? this.stagedReviewFiles.get(channel) : undefined;
    if (file) this.stagedReviewFiles.delete(channel);
    const sent = await this.gateway.send(channel, file ? { ...payload, files: [file] } : payload);
    return { ts: sent.id };
  }

  async sendWithRetry(say: SayFn, message: OutboundMessage): Promise<PostResult> {
    const result = await say(message);
    this.log('info', `[OUTBOUND_MESSAGE] say thread=${message.thread_ts} id=${result.ts ?? 'unknown'} actions=${describeButtons(message.blocks)}`);
    return result;
  }

  async update(channel: string, ts: string, message: MessageUpdate): Promise<void> {
    await this.gateway.edit(channel, ts, toDiscordPayload(message.text, message.blocks, this.gateway.maxMessageLength));
  }

  async upload(file: FileUpload): Promise<string> {
    this.stagedReviewFiles.set(file.channel, { name: file.filename, content: file.content });
    return file.filename;
  }

  async react(channel: string, ts: string, name: string): Promise<void> {
    await this.gateway.react(channel, ts, name);
  }

  async unreact(channel: string, ts: string, name: string): Promise<void> {
    await this.gateway.unreact(channel, ts, name);
  }
}
