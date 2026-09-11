import type { PlanSummary } from '@invoker/planning-core';
import type { SlackPlanDraft } from '@invoker/data-store';

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

export interface FileUpload {
  channel: string;
  threadTs: string;
  content: string;
  filename: string;
  title: string;
}

export type PlanDraftRecord = SlackPlanDraft;

export interface ChatTransport {
  post(channel: string, message: OutboundMessage): Promise<PostResult>;
  sendWithRetry(say: SayFn, message: OutboundMessage): Promise<PostResult>;
  update(channel: string, ts: string, message: MessageUpdate): Promise<void>;
  upload(file: FileUpload): Promise<string | undefined>;
  awaitUploadVisible?(channel: string, threadTs: string, fileId: string): Promise<void>;
  react(channel: string, ts: string, name: string): Promise<void>;
  unreact(channel: string, ts: string, name: string): Promise<void>;
}

export interface ChatBlocks {
  confirmPrompt(prompt: string, confirmKey: string): unknown[];
  planIntentPrompt(confirmKey: string): unknown[];
  planDraftCard(summary: PlanSummary, draft: PlanDraftRecord, state: 'ready' | 'kept'): unknown[];
  describeActions(blocks: unknown[] | undefined): string;
}

export type CoreLogFn = (level: 'info' | 'warn' | 'error', message: string) => void;
