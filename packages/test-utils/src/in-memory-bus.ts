import type { OrchestratorMessageBus } from '@invoker/core';

/**
 * No-op message bus for testing. Swallows all published messages.
 */
export class InMemoryBus implements OrchestratorMessageBus {
  publish(): void {}
}
