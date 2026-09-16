import { resolve } from 'node:path';

import { type MessageBus } from '@invoker/transport';
import {
  createTraceId,
  withTimeout,
  type LiveOwnerInfo,
} from './live-owner-bus.js';

export type LiveSubmissionResult = {
  workflowId: string;
  tasks: unknown[];
  ownerId?: string;
};

export const LIVE_RUN_NO_OWNER_ERROR = 'No running Invoker owner is reachable; start the owner or omit --live to run standalone';

export function validateLiveSubmissionResponse(raw: unknown): LiveSubmissionResult {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Live owner returned invalid headless.run response: expected object, got ${raw === null ? 'null' : typeof raw}`);
  }
  const response = raw as Record<string, unknown>;
  if (typeof response.workflowId !== 'string' || response.workflowId.length === 0) {
    throw new Error('Live owner returned invalid headless.run response: missing workflowId');
  }
  if (!Array.isArray(response.tasks)) {
    throw new Error('Live owner returned invalid headless.run response: missing tasks array');
  }
  return {
    workflowId: response.workflowId,
    tasks: response.tasks,
    ownerId: typeof response.ownerId === 'string' ? response.ownerId : undefined,
  };
}

export async function requestPlanRunFromLiveOwner(
  planPath: string,
  bus: MessageBus,
  timeoutMs = 15_000,
  traceChannel = 'invoker-cli.headless.run',
): Promise<LiveSubmissionResult> {
  const absolutePlanPath = resolve(planPath);
  const raw = await withTimeout(
    bus.request('headless.run', {
      planPath: absolutePlanPath,
      traceId: createTraceId(traceChannel),
    }),
    timeoutMs,
  );
  return validateLiveSubmissionResponse(raw);
}

export async function submitPlanToLiveOwner(
  planPath: string,
  bus: MessageBus,
  owner: LiveOwnerInfo,
  timeoutMs = 15_000,
  traceChannel = 'invoker-cli.headless.run',
): Promise<LiveSubmissionResult> {
  const submitted = await requestPlanRunFromLiveOwner(planPath, bus, timeoutMs, traceChannel);
  return {
    ...submitted,
    ownerId: owner.ownerId,
  };
}

export function formatLiveRunJsonOutput(workflowId: string): string {
  const result = {
    workflowId,
    status: 'success' as const,
    completedTasks: 0,
    failedTasks: 0,
    mode: 'live' as const,
  };
  return `${JSON.stringify({ workflow: { id: result.workflowId, status: result.status }, result })}\n`;
}
