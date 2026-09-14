export interface OutboundMessage {
  text: string;
  thread_ts: string;
  blocks?: unknown[];
}

export interface PostResult {
  ts?: string;
}

export type SayFn = (msg: OutboundMessage) => Promise<PostResult>;

export interface MessageUpdate {
  text: string;
  blocks?: unknown[];
}

export interface ChatTransport {
  post(channel: string, message: OutboundMessage): Promise<PostResult>;
  update(channel: string, ts: string, message: MessageUpdate): Promise<void>;
  react(channel: string, ts: string, name: string): Promise<void>;
  unreact(channel: string, ts: string, name: string): Promise<void>;
}

export interface ChatBlocks {
  confirmPrompt(prompt: string, confirmKey: string): unknown[];
  planIntentPrompt(confirmKey: string): unknown[];
}

export type CoreLogFn = (level: 'info' | 'warn' | 'error', message: string) => void;
