import type { Logger } from '@invoker/contracts';

import { recordWorkerDecisionRow, type WorkerDecisionStore } from '../worker-decision-ledger.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

import type { SlackBugScanClient } from './slack-bug-scan-client.js';
import { normalizeAllowedRepoHosts, resolveChannelRepoUrl } from './slack-bug-scan-repo-url.js';
import {
  recordCandidateOutcome,
  scanChannelForCandidates,
  SLACK_BUG_SCAN_WORKER_KIND,
  type SlackBugScanCandidate,
} from './slack-bug-scan-scanner.js';
import {
  resolveSlackBugScanAllowedRepoHosts,
  resolveSlackBugScanIntervalMs,
  resolveSlackBugScanMaxPerDay,
  resolveSlackBugScanMaxPerTick,
} from './slack-bug-scan.js';

export { SLACK_BUG_SCAN_WORKER_KIND };

export interface SlackBugScanClassifyResult {
  isBugComplaint: boolean;
  problemStatement?: string;
}

export type SlackBugScanClassifier = (input: {
  channelId: string;
  threadTs: string;
  repoUrl: string;
  threadText: string;
}) => Promise<SlackBugScanClassifyResult>;

export interface SlackBugScanDraftResult {
  planName: string;
  workflowId: string;
}

export type SlackBugScanPlanSubmitter = (input: {
  channelId: string;
  threadTs: string;
  repoUrl: string;
  problemStatement: string;
  threadText: string;
}) => Promise<SlackBugScanDraftResult>;

export interface SlackBugScanWorkerConfig {
  enabled?: boolean;
  client?: SlackBugScanClient;
  intervalMs?: number;
  tickOnStart?: boolean;
  startDelayMs?: number;
  store?: WorkerDecisionStore;
  classify?: SlackBugScanClassifier;
  draftAndSubmitPlan?: SlackBugScanPlanSubmitter;
  allowedRepoHosts?: readonly string[];
  maxAutoSubmissionsPerDay?: number;
  maxAutoSubmissionsPerTick?: number;
  onTick?: WorkerTick;
}

export interface SlackBugScanWorkerOptions {
  logger: Logger;
  client: SlackBugScanClient;
  store: WorkerDecisionStore;
  classify: SlackBugScanClassifier;
  draftAndSubmitPlan: SlackBugScanPlanSubmitter;
  allowedRepoHosts?: readonly string[];
  intervalMs?: number;
  tickOnStart?: boolean;
  startDelayMs?: number;
  maxAutoSubmissionsPerDay?: number;
  maxAutoSubmissionsPerTick?: number;
  onTick?: WorkerTick;
}

function dailyCapKey(dateIso: string): string {
  return `submission-count:${dateIso.slice(0, 10)}`;
}

function currentDailyCount(store: WorkerDecisionStore, dateIso: string): number {
  const row = store.getWorkerAction?.(SLACK_BUG_SCAN_WORKER_KIND, dailyCapKey(dateIso));
  const count = (row?.payload as { count?: number } | undefined)?.count;
  return typeof count === 'number' ? count : 0;
}

function incrementDailyCount(store: WorkerDecisionStore, dateIso: string, current: number): void {
  recordWorkerDecisionRow(store, {
    workerKind: SLACK_BUG_SCAN_WORKER_KIND,
    actionType: 'daily-submission-count',
    externalKey: dailyCapKey(dateIso),
    subjectType: 'day',
    subjectId: dateIso.slice(0, 10),
    status: 'completed',
    summary: `${current + 1} workflow(s) auto-filed today`,
    payload: { count: current + 1 },
  });
}

function currentSlackTs(): string {
  return (Date.now() / 1000).toFixed(6);
}

function threadTextFor(candidate: SlackBugScanCandidate): string {
  return candidate.threadMessages.map((m) => m.text).join('\n---\n');
}

async function postOutcome(
  client: SlackBugScanClient,
  logger: Logger,
  candidate: SlackBugScanCandidate,
  text: string,
): Promise<void> {
  try {
    await client.postMessage(candidate.channelId, candidate.threadTs, text);
  } catch (err) {
    logger.error(`[worker:${SLACK_BUG_SCAN_WORKER_KIND}] failed to post outcome message`, {
      module: 'slack-bug-scan', channelId: candidate.channelId, threadTs: candidate.threadTs, err,
    });
  }
}

export function createSlackBugScanWorker(options: SlackBugScanWorkerOptions): WorkerRuntime {
  const maxPerDay = options.maxAutoSubmissionsPerDay ?? resolveSlackBugScanMaxPerDay();
  const maxPerTick = options.maxAutoSubmissionsPerTick ?? resolveSlackBugScanMaxPerTick();
  const allowedRepoHosts = normalizeAllowedRepoHosts(options.allowedRepoHosts ?? resolveSlackBugScanAllowedRepoHosts());
  if (allowedRepoHosts.length === 0) {
    throw new Error('slack-bug-scan worker requires at least one allowed repo host to be configured.');
  }

  return createWorkerRuntime({
    kind: SLACK_BUG_SCAN_WORKER_KIND,
    logger: options.logger,
    intervalMs: options.intervalMs ?? resolveSlackBugScanIntervalMs(),
    tickOnStart: options.tickOnStart ?? true,
    startDelayMs: options.startDelayMs,
    onTick: async (ctx) => {
      ctx.signal?.throwIfAborted();
      await options.onTick?.(ctx);
      ctx.signal?.throwIfAborted();

      const nowIso = new Date().toISOString();
      const nowSlackTs = currentSlackTs();
      const channels = await options.client.listMemberChannels();
      let submittedThisTick = 0;

      for (const channel of channels) {
        if (ctx.signal?.aborted) return;
        const repoUrl = resolveChannelRepoUrl(channel.topic, channel.purpose, allowedRepoHosts);
        if (!repoUrl) continue;

        const candidates = await scanChannelForCandidates(options.client, options.store, channel.id, nowSlackTs);
        for (const candidate of candidates) {
          if (ctx.signal?.aborted) return;

          const dailyCount = currentDailyCount(options.store, nowIso);
          if (dailyCount >= maxPerDay) {
            recordCandidateOutcome(options.store, candidate, 'skipped', 'Daily auto-submit cap exhausted', { reason: 'daily-cap-exhausted' });
            await postOutcome(options.client, options.logger, candidate,
              'I would have filed this as a bug, but hit today\'s auto-submit cap. A human should look at this thread.');
            continue;
          }
          if (submittedThisTick >= maxPerTick) {
            continue;
          }

          const threadText = threadTextFor(candidate);
          let classification: SlackBugScanClassifyResult;
          try {
            classification = await options.classify({
              channelId: candidate.channelId,
              threadTs: candidate.threadTs,
              repoUrl,
              threadText,
            });
          } catch (err) {
            recordCandidateOutcome(options.store, candidate, 'failed', 'Classification failed', {
              error: err instanceof Error ? err.message : String(err),
            });
            continue;
          }

          if (!classification.isBugComplaint) {
            recordCandidateOutcome(options.store, candidate, 'skipped', 'Classified as not a bug complaint');
            continue;
          }

          try {
            const result = await options.draftAndSubmitPlan({
              channelId: candidate.channelId,
              threadTs: candidate.threadTs,
              repoUrl,
              problemStatement: classification.problemStatement ?? candidate.triggerMessage.text,
              threadText,
            });
            recordCandidateOutcome(options.store, candidate, 'completed', `Filed workflow ${result.workflowId}`, {
              workflowId: result.workflowId,
              planName: result.planName,
            });
            incrementDailyCount(options.store, nowIso, dailyCount);
            submittedThisTick += 1;
            await postOutcome(options.client, options.logger, candidate,
              `Filed as workflow \`${result.workflowId}\`: ${result.planName}`);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            recordCandidateOutcome(options.store, candidate, 'failed', 'Plan draft/submit failed', { error: message });
            await postOutcome(options.client, options.logger, candidate,
              `Detected this as a bug report but failed to auto-file it: ${message}`);
          }
        }
      }
    },
  });
}

export function registerSlackBugScanWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: SLACK_BUG_SCAN_WORKER_KIND,
    note: 'Scans Slack threads across all member channels, LLM-classifies bug complaints, and auto-submits an Invoker plan with no human approval gate. High blast-radius — off by default.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime => {
      const config = deps.slackBugScan;
      if (config?.enabled !== true) {
        throw new Error('slack-bug-scan worker is disabled; set slackBugScan.enabled to true to start it.');
      }
      if (!config?.client || !config.classify || !config.draftAndSubmitPlan) {
        throw new Error('slack-bug-scan worker requires client, classify, and draftAndSubmitPlan to be configured.');
      }
      return createSlackBugScanWorker({
        logger: deps.logger,
        client: config.client,
        store: config.store ?? deps.store,
        classify: config.classify,
        draftAndSubmitPlan: config.draftAndSubmitPlan,
        allowedRepoHosts: config.allowedRepoHosts,
        intervalMs: config.intervalMs,
        tickOnStart: config.tickOnStart,
        startDelayMs: config.startDelayMs,
        maxAutoSubmissionsPerDay: config.maxAutoSubmissionsPerDay,
        maxAutoSubmissionsPerTick: config.maxAutoSubmissionsPerTick,
        onTick: config.onTick,
      });
    },
  });
  return registry;
}
