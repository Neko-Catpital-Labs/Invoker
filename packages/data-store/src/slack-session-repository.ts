import type {
  Conversation,
  PersistenceAdapter,
  SlackLaunchContext,
  SlackPendingConfirmation,
} from './adapter.js';

export const SLACK_PENDING_CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;

export interface CreateSlackPendingConfirmation {
  confirmKey: string;
  threadTs: string;
  channelId: string;
  userId: string;
  kind: string;
  payload: unknown;
}

export interface PendingSlackConfirmation extends Omit<SlackPendingConfirmation, 'payloadJson'> {
  payload: unknown;
}

export class SlackSessionRepository {
  constructor(private readonly adapter: PersistenceAdapter) {}

  saveLaunchContext(context: SlackLaunchContext): void {
    this.adapter.saveSlackLaunchContext(context);
  }

  getLaunchContext(threadTs: string): SlackLaunchContext | null {
    return this.adapter.loadSlackLaunchContext(threadTs) ?? null;
  }

  deleteLaunchContext(threadTs: string): void {
    this.adapter.deleteSlackLaunchContext(threadTs);
  }

  createPendingConfirmation(
    confirmation: CreateSlackPendingConfirmation,
    createdAt = new Date(),
  ): PendingSlackConfirmation {
    const createdAtIso = createdAt.toISOString();
    const pending: PendingSlackConfirmation = {
      ...confirmation,
      createdAt: createdAtIso,
      expiresAt: new Date(createdAt.getTime() + SLACK_PENDING_CONFIRMATION_TTL_MS).toISOString(),
    };
    this.adapter.saveSlackPendingConfirmation({
      ...pending,
      payloadJson: JSON.stringify(pending.payload),
    });
    return pending;
  }

  getPendingConfirmation(
    confirmKey: string,
    now = new Date(),
  ): PendingSlackConfirmation | null {
    this.purgeExpiredPendingConfirmations(now);
    const confirmation = this.adapter.loadSlackPendingConfirmation(confirmKey);
    if (!confirmation) return null;
    const { payloadJson, ...pending } = confirmation;
    return {
      ...pending,
      payload: this.parsePayload(payloadJson),
    };
  }

  deletePendingConfirmation(confirmKey: string): void {
    this.adapter.deleteSlackPendingConfirmation(confirmKey);
  }

  purgeExpiredPendingConfirmations(now = new Date()): number {
    return this.adapter.purgeExpiredSlackPendingConfirmations(now.toISOString());
  }

  listActivePlanThreads(channelId: string, userId: string): Conversation[] {
    return this.adapter.listActivePlanConversations(channelId, userId);
  }

  private parsePayload(payloadJson: string): unknown {
    try {
      return JSON.parse(payloadJson) as unknown;
    } catch {
      return payloadJson;
    }
  }
}
