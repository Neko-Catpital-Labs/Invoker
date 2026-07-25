import type { Logger } from '@invoker/contracts';

import {
  createPrMaintenanceGitHub,
  type PrMaintenanceGitHub,
  type PullRequestIssueComment,
} from './pr-maintenance-github.js';
import { spawnPrMaintenanceCommand } from './pr-maintenance-command.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const PR_QUEUE_DEQUEUE_PUBLISHER_WORKER_KIND = 'pr-queue-dequeue-publisher';
export const DEFAULT_PR_QUEUE_DEQUEUE_PUBLISHER_INTERVAL_MS = 60_000;

export interface PrQueueDequeuedPublisherInput {
  repo: string;
  prNumber: number;
  headSha: string;
  dequeueCommentId: string;
  failedChecks: string[];
  workflowId?: string;
  baseRef?: string;
  labelsJson?: string;
}

export interface PrQueueDequeuedPublisherPolicyOptions {
  store: {
    findReviewGateByPr?(prNumber: string): { workflowId: string } | undefined;
  };
  publish(input: PrQueueDequeuedPublisherInput): void;
  logger: Logger;
  repo?: string;
  author?: string;
  github?: PrMaintenanceGitHub;
}

export interface PrQueueDequeuedPublisherWorkerOptions extends PrQueueDequeuedPublisherPolicyOptions {
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
}

export function parseMergifyDequeuedComment(comment: PullRequestIssueComment): {
  headSha: string;
  failedChecks: string[];
} | undefined {
  const payload = comment.body.match(/-\*- Mergify Payload -\*-\s*\n(\{[\s\S]*?\})/);
  if (!payload?.[1]) return undefined;
  let parsed: { state?: unknown };
  try {
    parsed = JSON.parse(payload[1]) as { state?: unknown };
  } catch {
    return undefined;
  }
  if (parsed.state !== 'dequeued') return undefined;
  const headSha = comment.body.match(/Left the queue .* at `([0-9a-f]{7,})`/i)?.[1];
  if (!headSha) return undefined;
  const failedChecks = sectionLines(comment.body, 'Failing checks');
  return { headSha, failedChecks };
}

export function registerPrQueueDequeuePublisherWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_QUEUE_DEQUEUE_PUBLISHER_WORKER_KIND,
    note: 'Publishes Mergify queue-dequeue lifecycle wakeups.',
    source: 'built-in',
    factory: (deps) => createPrQueueDequeuePublisherWorker({
      store: deps.store,
      publish: deps.prLifecyclePublisher?.publishQueueDequeued ?? (() => {}),
      logger: deps.logger,
    }),
  });
  return registry;
}

export function createPrQueueDequeuePublisherTick(
  options: PrQueueDequeuedPublisherPolicyOptions,
): WorkerTick {
  return async () => {
    const repo = options.repo ?? process.env.INVOKER_GITHUB_TARGET_REPO ?? 'Neko-Catpital-Labs/Invoker';
    const author = options.author ?? process.env.INVOKER_PR_CRON_AUTHOR ?? 'EdbertChan';
    const github = options.github ?? createPrMaintenanceGitHub({
      run: spawnPrMaintenanceCommand,
      repo,
      author,
      logger: options.logger,
      sleep: async () => {},
    });
    const pullRequests = await github.listOpenPullRequests(['number', 'headRefOid', 'baseRefName', 'labels']);
    for (const pullRequest of pullRequests) {
      const prNumber = numberValue(pullRequest.number);
      const currentHeadSha = stringValue(pullRequest.headRefOid);
      if (!prNumber || !currentHeadSha) continue;
      const events = (await github.fetchIssueComments(prNumber))
        .map((comment) => ({ comment, dequeue: parseMergifyDequeuedComment(comment) }))
        .filter((candidate): candidate is { comment: PullRequestIssueComment; dequeue: { headSha: string; failedChecks: string[] } } =>
          candidate.dequeue !== undefined && candidate.dequeue.headSha === currentHeadSha,
        )
        .sort((a, b) => a.comment.updatedAt.localeCompare(b.comment.updatedAt));
      const latest = events.at(-1);
      if (!latest) continue;
      const lookup = options.store.findReviewGateByPr?.(String(prNumber));
      options.publish({
        repo,
        prNumber,
        headSha: currentHeadSha,
        dequeueCommentId: latest.comment.id,
        failedChecks: latest.dequeue.failedChecks,
        workflowId: lookup?.workflowId,
        baseRef: stringValue(pullRequest.baseRefName),
        labelsJson: JSON.stringify(pullRequest.labels ?? []),
      });
    }
  };
}

export function createPrQueueDequeuePublisherWorker(
  options: PrQueueDequeuedPublisherWorkerOptions,
): WorkerRuntime {
  return createWorkerRuntime({
    kind: PR_QUEUE_DEQUEUE_PUBLISHER_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_PR_QUEUE_DEQUEUE_PUBLISHER_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? true,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? createPrQueueDequeuePublisherTick(options),
  });
}

function sectionLines(body: string, heading: string): string[] {
  const section = body.match(new RegExp(`(?:^|\\n)${heading}\\s*\\n([\\s\\S]*?)(?:\\n\\s*\\n|$)`, 'i'))?.[1] ?? '';
  return section.split('\n')
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
