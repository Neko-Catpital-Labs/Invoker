/**
 * Host seams — the planner/repo/context callbacks the SlackSurface needs,
 * reconstructed outside Electron.
 *
 * `planningCommandBuilder` and `prepareRepoCheckout` reuse @invoker/execution-engine
 * exactly as `wireSlackBot` does. `gatherWorkflowContext` is the cross-process
 * (degraded) variant: it reads tasks + task output over IPC and the planning
 * conversation from the manager's own store. Per-task agent-session transcripts
 * are not reachable cross-process, so the transcript is empty and task output
 * carries the per-task detail.
 */

import { registerBuiltinAgents, RepoPool } from '@invoker/execution-engine';
import type { ConversationRepository, WorkflowChannelRepository } from '@invoker/data-store';
import type { PlanningCommandBuilder, WorkflowContext } from '@invoker/surfaces';
import type { InvokerClient } from './invoker-client.js';
import { errMessage } from './util.js';

/** Build the planner command from the built-in agent registry (cursor/omp/codex). */
export function createPlanningCommandBuilder(): PlanningCommandBuilder {
  const registry = registerBuiltinAgents();
  return (opts) => registry.getPlanningOrThrow(opts.tool).buildPlanningCommand(opts.prompt, { model: opts.model });
}

/** Check out a repo for the planning agent through the shared repo queue; returns the working dir. */
export function createPrepareRepoCheckout(cacheDir: string): (repoUrl: string) => Promise<string> {
  const pool = new RepoPool({ cacheDir });
  return (repoUrl) => pool.ensureCloneThroughRepoQueue(repoUrl);
}

export interface GatherWorkflowContextDeps {
  client: Pick<InvokerClient, 'getWorkflowBundle' | 'getTaskOutput'>;
  conversationRepo: Pick<ConversationRepository, 'loadConversation'>;
  workflowChannelRepo: Pick<WorkflowChannelRepository, 'getByWorkflowId'>;
  log: (level: string, message: string) => void;
}

export function createGatherWorkflowContext(
  deps: GatherWorkflowContextDeps,
): (workflowId: string) => Promise<WorkflowContext> {
  return async (workflowId) => {
    const { tasks } = await deps.client.getWorkflowBundle(workflowId);
    const contextTasks: WorkflowContext['tasks'] = [];
    for (const task of tasks) {
      if (task.config.isMergeNode) continue;
      let output = '';
      try {
        output = await deps.client.getTaskOutput(task.id);
      } catch (err) {
        deps.log('warn', `gatherWorkflowContext: task-output failed for ${task.id}: ${errMessage(err)}`);
      }
      contextTasks.push({
        id: task.id,
        status: task.status,
        agentName: task.execution.agentName ?? task.execution.lastAgentName ?? '',
        transcript: [],
        output: output || undefined,
      });
    }

    let planning: WorkflowContext['planning'] = [];
    const mapping = deps.workflowChannelRepo.getByWorkflowId(workflowId);
    if (mapping?.lobbyThreadTs) {
      const convo = deps.conversationRepo.loadConversation(mapping.lobbyThreadTs);
      planning = (convo?.messages ?? []).map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      }));
    }

    return { workflowId, planning, tasks: contextTasks };
  };
}
