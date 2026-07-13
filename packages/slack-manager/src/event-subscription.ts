/**
 * Event subscription — forwards Invoker's broadcast events to the Slack surface.
 *
 * `surface.event` carries a full SurfaceEvent (the workflow-progress card,
 * published by the owner's surface-event relay). `task.delta` carries a raw
 * TaskDelta, wrapped into a `task_delta` surface event so the surface renders
 * per-task messages + Approve/Reject/Provide-Input buttons.
 *
 * Subscriptions are registered through the InvokerClient, which re-applies them
 * on a fresh bus after a reconnect (live-forward only; no replay — the next
 * delta/progress refreshes the in-place cards).
 */

import { Channels } from '@invoker/transport';
import type { SurfaceEvent } from '@invoker/surfaces';
import type { TaskDelta } from '@invoker/workflow-core';
import type { InvokerClient } from './invoker-client.js';
import { errMessage } from './util.js';

export interface EventSubscriptionDeps {
  client: Pick<InvokerClient, 'subscribe'>;
  slack: { handleEvent: (event: SurfaceEvent) => Promise<void> };
  log: (level: string, message: string) => void;
}

export function startEventSubscription(deps: EventSubscriptionDeps): () => void {
  const { client, slack, log } = deps;
  const forward = (event: SurfaceEvent): void => {
    void slack.handleEvent(event).catch((err) => log('warn', `handleEvent failed: ${errMessage(err)}`));
  };

  const unsubProgress = client.subscribe(Channels.SURFACE_EVENT, (message) => {
    forward(message as SurfaceEvent);
  });
  const unsubDelta = client.subscribe(Channels.TASK_DELTA, (message) => {
    forward({ type: 'task_delta', delta: message as TaskDelta });
  });

  return () => {
    unsubProgress();
    unsubDelta();
  };
}
