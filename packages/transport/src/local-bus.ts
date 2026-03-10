/**
 * LocalBus — In-process MessageBus implementation using EventEmitter-style maps.
 *
 * Used for testing and single-process mode (e.g., CLI).
 */

import type {
  MessageBus,
  MessageHandler,
  RequestHandler,
  Unsubscribe,
} from './message-bus.js';

export class LocalBus implements MessageBus {
  private subscribers = new Map<string, Set<MessageHandler>>();
  private requestHandlers = new Map<string, RequestHandler>();

  subscribe<T>(channel: string, handler: MessageHandler<T>): Unsubscribe {
    if (!this.subscribers.has(channel)) {
      this.subscribers.set(channel, new Set());
    }
    const handlers = this.subscribers.get(channel)!;
    handlers.add(handler as MessageHandler);

    return () => {
      handlers.delete(handler as MessageHandler);
      if (handlers.size === 0) {
        this.subscribers.delete(channel);
      }
    };
  }

  publish<T>(channel: string, message: T): void {
    const handlers = this.subscribers.get(channel);
    if (!handlers) return;

    for (const handler of handlers) {
      handler(message);
    }
  }

  onRequest<Req, Res>(channel: string, handler: RequestHandler<Req, Res>): Unsubscribe {
    this.requestHandlers.set(channel, handler as RequestHandler);
    return () => {
      this.requestHandlers.delete(channel);
    };
  }

  async request<Req, Res>(channel: string, message: Req): Promise<Res> {
    const handler = this.requestHandlers.get(channel);
    if (!handler) {
      throw new Error(`No request handler registered for channel: ${channel}`);
    }
    return handler(message) as Promise<Res>;
  }

  disconnect(): void {
    this.subscribers.clear();
    this.requestHandlers.clear();
  }
}
