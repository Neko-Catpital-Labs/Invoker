/**
 * ConversationRepository — Domain-level API for conversation persistence.
 *
 * Wraps PersistenceAdapter with JSON serialization of messages/plans,
 * error handling, and logging. Callers work with typed objects, not
 * raw JSON strings.
 */

import type { PlanDefinition } from '@invoker/workflow-core';
import type { PersistenceAdapter, Conversation, ConversationMessage } from './adapter.js';

// ── Public Types ─────────────────────────────────────────────

export interface ConversationEntry {
  threadTs: string;
  channelId: string;
  userId: string;
  messages: ConversationMessageEntry[];
  extractedPlan: PlanDefinition | null;
  planSubmitted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessageEntry {
  role: 'user' | 'assistant';
  content: unknown; // Deserialized MessageParam content
}

// ── Logger ───────────────────────────────────────────────────

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const defaultLogger: Logger = {
  info: (msg) => console.log(`[conversation-repo] ${msg}`),
  warn: (msg) => console.warn(`[conversation-repo] ${msg}`),
  error: (msg) => console.error(`[conversation-repo] ${msg}`),
};

// ── Repository ───────────────────────────────────────────────

export class ConversationRepository {
  private adapter: PersistenceAdapter;
  private log: Logger;

  constructor(adapter: PersistenceAdapter, logger?: Logger) {
    this.adapter = adapter;
    this.log = logger ?? defaultLogger;
  }

  /**
   * Save or update a conversation with its messages.
   * Creates the conversation row and appends any new messages.
   */
  saveConversation(
    threadTs: string,
    messages: ConversationMessageEntry[],
    extractedPlan?: PlanDefinition | null,
    planSubmitted?: boolean,
    channelId?: string,
    userId?: string,
  ): void {
    const now = new Date().toISOString();

    const existing = this.adapter.loadConversation(threadTs);

    const planJson = extractedPlan ? JSON.stringify(extractedPlan) : null;

    if (existing) {
      this.adapter.updateConversation(threadTs, {
        extractedPlan: planJson ?? existing.extractedPlan,
        planSubmitted: planSubmitted ?? existing.planSubmitted,
        updatedAt: now,
      });
    } else {
      this.adapter.saveConversation({
        threadTs,
        channelId: channelId ?? '',
        userId: userId ?? '',
        extractedPlan: planJson,
        planSubmitted: planSubmitted ?? false,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Determine how many messages already exist and append new ones
    const existingMessages = this.adapter.loadMessages(threadTs);
    const newMessages = messages.slice(existingMessages.length);

    for (const msg of newMessages) {
      const contentJson = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
      this.adapter.appendMessage(threadTs, msg.role, contentJson);
    }

    this.log.info(
      `Saved conversation ${threadTs}: ${newMessages.length} new messages, total ${messages.length}`,
    );
  }

  /**
   * Load a conversation with all its messages, deserializing JSON fields.
   * Returns null if the conversation does not exist.
   */
  loadConversation(threadTs: string): ConversationEntry | null {
    const conv = this.adapter.loadConversation(threadTs);
    if (!conv) return null;

    const rawMessages = this.adapter.loadMessages(threadTs);

    return {
      threadTs: conv.threadTs,
      channelId: conv.channelId,
      userId: conv.userId,
      messages: rawMessages.map((m) => ({
        role: m.role,
        content: this.parseJson(m.content, `message seq=${m.seq} in ${threadTs}`),
      })),
      extractedPlan: this.parsePlan(conv.extractedPlan),
      planSubmitted: conv.planSubmitted,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
    };
  }

  /**
   * Delete a conversation and all its messages.
   */
  deleteConversation(threadTs: string): void {
    this.adapter.deleteConversation(threadTs);
    this.log.info(`Deleted conversation ${threadTs}`);
  }

  /**
   * List all active (non-submitted) conversations.
   * Returns conversation metadata without messages for efficiency.
   */
  listActiveConversations(): Array<Omit<ConversationEntry, 'messages'>> {
    const conversations = this.adapter.listActiveConversations();
    return conversations.map((conv) => ({
      threadTs: conv.threadTs,
      channelId: conv.channelId,
      userId: conv.userId,
      extractedPlan: this.parsePlan(conv.extractedPlan),
      planSubmitted: conv.planSubmitted,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
    }));
  }

  /**
   * Delete conversations older than the specified number of days.
   * Returns the count of deleted conversations.
   */
  cleanupOldConversations(olderThanDays: number): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);
    const cutoffIso = cutoff.toISOString();

    const deleted = this.adapter.deleteConversationsOlderThan(cutoffIso);
    this.log.info(`Cleaned up ${deleted} conversations older than ${olderThanDays} days`);
    return deleted;
  }

  // ── Private helpers ──────────────────────────────────────

  private parsePlan(json: string | null): PlanDefinition | null {
    if (!json) return null;
    try {
      return JSON.parse(json) as PlanDefinition;
    } catch (err) {
      this.log.warn(`Failed to parse extractedPlan: ${err}`);
      return null;
    }
  }

  private parseJson(json: string, context: string): unknown {
    try {
      return JSON.parse(json);
    } catch {
      // Content may be a plain string, not JSON — return as-is
      this.log.warn(`Non-JSON content in ${context}, returning raw string`);
      return json;
    }
  }
}
