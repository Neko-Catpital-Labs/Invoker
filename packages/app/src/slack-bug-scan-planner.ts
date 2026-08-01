import { randomUUID } from 'node:crypto';
import type { Logger } from '@invoker/contracts';
import type { AgentRegistry } from '@invoker/execution-engine';
import type { SlackBugScanPlanSubmitter } from '@invoker/execution-engine';
import type { InvokerConfig } from './config.js';
import { loadPlanSubmissionBundle, type PlanSubmissionLoadDeps } from './plan-submission-loader.js';
import { provisionPlanningWorktree, releasePlanningWorktree, type PlanningRepoPool } from './planning-chat-worktree.js';
import type { PlanningCommandBuilder } from '@invoker/surfaces';

export interface SlackBugScanPlannerDeps {
  config: InvokerConfig;
  repoPool: PlanningRepoPool;
  persistence: PlanSubmissionLoadDeps['persistence'];
  orchestrator: PlanSubmissionLoadDeps['orchestrator'];
  planningCommandBuilder?: PlanningCommandBuilder;
  executionAgentRegistry?: AgentRegistry;
  logger?: Logger;
}

function buildDraftPrompt(input: { repoUrl: string; problemStatement: string; threadText: string }): string {
  return [
    `A user reported a bug in this repository. Draft a complete Invoker YAML plan that fixes it.`,
    `Use exactly this repoUrl: ${input.repoUrl}`,
    '',
    `Problem: ${input.problemStatement}`,
    '',
    'Original Slack thread for context:',
    input.threadText,
    '',
    'Draft the full plan now. Return the YAML in a ```yaml code block.',
  ].join('\n');
}

export function createSlackBugScanPlanner(deps: SlackBugScanPlannerDeps): SlackBugScanPlanSubmitter {
  return async (input) => {
    const { PlanConversation, extractYamlPlan, selectHarnessSessionDriver, BUILTIN_HARNESS_PRESETS, DEFAULT_HARNESS_PRESET }
      = await import('@invoker/surfaces');
    const presets = { ...BUILTIN_HARNESS_PRESETS, ...(deps.config.slackHarnessPresets ?? {}) };
    const presetKey = deps.config.defaultSlackHarnessPreset ?? DEFAULT_HARNESS_PRESET;
    const preset = presets[presetKey];
    if (!preset) throw new Error(`Unknown planner preset "${presetKey}".`);

    const sessionId = randomUUID();
    const baseBranch = deps.config.defaultBranch ?? 'main';
    const { worktreePath } = await provisionPlanningWorktree(deps.repoPool, {
      repoUrl: input.repoUrl,
      baseBranch,
      sessionId,
    });

    try {
      const conversation = new PlanConversation({
        threadTs: sessionId,
        tool: preset.tool,
        model: preset.model,
        workingDir: worktreePath,
        timeoutMs: (deps.config.planningTimeoutSeconds ?? 7200) * 1000,
        defaultBranch: baseBranch,
        repoUrl: input.repoUrl,
        preferStackedWorkflows: true,
        planningCommandBuilder: deps.planningCommandBuilder,
        harnessSessionDriver: selectHarnessSessionDriver(preset, {
          executionAgentRegistry: deps.executionAgentRegistry,
          planningCommandBuilder: deps.planningCommandBuilder,
        }),
        log: deps.logger
          ? (_source, level, message) => {
            if (level === 'error') deps.logger?.error(message, { module: 'slack-bug-scan' });
            else if (level === 'warn') deps.logger?.warn(message, { module: 'slack-bug-scan' });
            else deps.logger?.info(message, { module: 'slack-bug-scan' });
          }
          : undefined,
      });

      const plannerOutput = await conversation.sendMessage(buildDraftPrompt(input));
      const planText = extractYamlPlan(plannerOutput);
      if (!planText) throw new Error('Planner did not return a valid YAML plan.');

      const loaded = await loadPlanSubmissionBundle(planText, {
        persistence: deps.persistence,
        orchestrator: deps.orchestrator,
        logger: deps.logger,
      }, { logLabel: 'slack-bug-scan' });

      return { planName: loaded.planName, workflowId: loaded.workflowId };
    } finally {
      await releasePlanningWorktree(deps.repoPool, {
        repoUrl: input.repoUrl,
        baseCommit: await deps.repoPool.resolveBaseCommit(input.repoUrl, baseBranch),
        sessionId,
      }).catch(() => undefined);
    }
  };
}
