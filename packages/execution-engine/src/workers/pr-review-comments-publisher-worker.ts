import type { Logger } from '@invoker/contracts';

import { createPrMaintenanceGitHub, type PrMaintenanceGitHub } from './pr-maintenance-github.js';
import { spawnPrMaintenanceCommand } from './pr-maintenance-command.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const PR_REVIEW_COMMENTS_PUBLISHER_WORKER_KIND = 'pr-review-comments-publisher';
export const DEFAULT_PR_REVIEW_COMMENTS_PUBLISHER_INTERVAL_MS = 60_000;

export interface PrReviewCommentsPublisherInput {
  repo: string;
  prNumber: number;
  headSha: string;
  commentMarker: string;
  commentUrls: string[];
  workflowId?: string;
  baseRef?: string;
  labelsJson?: string;
}

export interface PrReviewCommentsPublisherStore {
  findReviewGateByPr?(prNumber: string): { workflowId: string } | undefined;
}

export interface PrReviewCommentsPublisherPolicyOptions {
  store: PrReviewCommentsPublisherStore;
  publish(input: PrReviewCommentsPublisherInput): void;
  logger: Logger;
  repo?: string;
  author?: string;
  botLogin?: string;
  github?: PrMaintenanceGitHub;
}

export interface PrReviewCommentsPublisherWorkerOptions extends PrReviewCommentsPublisherPolicyOptions {
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
}

export function registerPrReviewCommentsPublisherWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_REVIEW_COMMENTS_PUBLISHER_WORKER_KIND,
    note: 'Publishes unresolved CodeRabbit review-comment lifecycle wakeups.',
    source: 'built-in',
    factory: (deps) => createPrReviewCommentsPublisherWorker({
      store: deps.store,
      publish: deps.prLifecyclePublisher?.publishReviewComments ?? (() => {}),
      logger: deps.logger,
    }),
  });
  return registry;
}

export function createPrReviewCommentsPublisherTick(
  options: PrReviewCommentsPublisherPolicyOptions,
): WorkerTick {
  return async () => {
    const repo = options.repo ?? process.env.INVOKER_GITHUB_TARGET_REPO ?? 'Neko-Catpital-Labs/Invoker';
    const author = options.author ?? process.env.INVOKER_PR_CRON_AUTHOR ?? 'EdbertChan';
    const botLogin = options.botLogin ?? process.env.INVOKER_CODERABBIT_LOGIN ?? 'coderabbitai[bot]';
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
      const headSha = stringValue(pullRequest.headRefOid);
      if (!prNumber || !headSha) continue;
      const comments = await github.fetchCoderabbitComments(prNumber, botLogin);
      const marker = comments.map((comment) => comment.updatedAt).filter(Boolean).sort().at(-1);
      if (!marker) continue;
      const lookup = options.store.findReviewGateByPr?.(String(prNumber));
      options.publish({
        repo,
        prNumber,
        headSha,
        commentMarker: marker,
        commentUrls: comments.map((comment) => comment.htmlUrl).filter((url): url is string => Boolean(url)),
        workflowId: lookup?.workflowId,
        baseRef: stringValue(pullRequest.baseRefName),
        labelsJson: JSON.stringify(pullRequest.labels ?? []),
      });
    }
  };
}

export function createPrReviewCommentsPublisherWorker(
  options: PrReviewCommentsPublisherWorkerOptions,
): WorkerRuntime {
  return createWorkerRuntime({
    kind: PR_REVIEW_COMMENTS_PUBLISHER_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_PR_REVIEW_COMMENTS_PUBLISHER_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? true,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? createPrReviewCommentsPublisherTick(options),
  });
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
