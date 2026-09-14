import type {
  ChatSurface,
  Conversation,
  PersistenceAdapter,
  SlackLaunchContext,
  SlackPendingConfirmation,
} from './adapter.js';
import { DEFAULT_CHAT_SURFACE } from './adapter.js';

export interface CreateSlackPendingConfirmation {
  confirmKey: string;
  threadTs: string;
  channelId: string;
  userId: string;
  kind: string;
  payload: unknown;
  surface?: ChatSurface;
}

export interface PendingSlackConfirmation extends Omit<SlackPendingConfirmation, 'payloadJson'> {
  payload: unknown;
}

export class SlackSessionRepository {
  constructor(private readonly adapter: PersistenceAdapter) {}

  saveLaunchContext(context: SlackLaunchContext): void {
    this.adapter.saveSlackLaunchContext(context);
  }

  getLaunchContext(threadTs: string, surface?: ChatSurface): SlackLaunchContext | null {
    return this.adapter.loadSlackLaunchContext(threadTs, surface) ?? null;
  }

  deleteLaunchContext(threadTs: string, surface?: ChatSurface): void {
    this.adapter.deleteSlackLaunchContext(threadTs, surface);
  }

  createPendingConfirmation(
    confirmation: CreateSlackPendingConfirmation,
    createdAt = new Date(),
  ): PendingSlackConfirmation {
    const createdAtIso = createdAt.toISOString();
    const pending: PendingSlackConfirmation = {
      ...confirmation,
      surface: confirmation.surface ?? DEFAULT_CHAT_SURFACE,
      createdAt: createdAtIso,
      // Confirmations never expire: a staged plan stays submittable until it
      // is explicitly consumed or cancelled. The column is kept populated only
      // for schema compatibility and has no read semantics.
      expiresAt: createdAtIso,
    };
    this.adapter.saveSlackPendingConfirmation({
      ...pending,
      payloadJson: JSON.stringify(pending.payload),
    });
    return pending;
  }

  getPendingConfirmation(confirmKey: string, surface?: ChatSurface): PendingSlackConfirmation | null {
    const confirmation = this.adapter.loadSlackPendingConfirmation(confirmKey, surface);
    return confirmation ? this.toPending(confirmation) : null;
  }

  /** The most recently staged confirmation for a thread, regardless of key. */
  getLatestPendingConfirmationForThread(threadTs: string, surface?: ChatSurface): PendingSlackConfirmation | null {
    const confirmation = this.adapter.loadLatestSlackPendingConfirmationByThread(threadTs, surface);
    return confirmation ? this.toPending(confirmation) : null;
  }

  deletePendingConfirmation(confirmKey: string): void {
    this.adapter.deleteSlackPendingConfirmation(confirmKey);
  }

  listActivePlanThreads(channelId: string, userId: string, surface?: ChatSurface): Conversation[] {
    return this.adapter.listActivePlanConversations(channelId, userId, surface);
  }

  private toPending(confirmation: SlackPendingConfirmation): PendingSlackConfirmation {
    const { payloadJson, ...pending } = confirmation;
    return {
      ...pending,
      payload: this.parsePayload(payloadJson),
    };
  }

  private parsePayload(payloadJson: string): unknown {
    try {
      return JSON.parse(payloadJson) as unknown;
    } catch {
      return payloadJson;
    }
  }
}
