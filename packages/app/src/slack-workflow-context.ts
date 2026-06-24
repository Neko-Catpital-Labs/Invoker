import type { PersistenceAdapter, ConversationRepository, WorkflowChannelRepository } from '@invoker/data-store';
import type { AgentRegistry } from '@invoker/execution-engine';
import { resolveSessionId, resolveAgentName } from './cost-rollup.js';
import { resolveAgentSession } from './headless.js';

export interface WorkflowContextResult {
  workflowId: string;
  planning: { role: string; content: string }[];
  tasks: Array<{ id: string; status: string; agentName: string; transcript: { role: string; content: string }[]; output?: string }>;
}

export interface HarnessPresetSpec {
  tool: string;
  model?: string;
}

export function presetToExecutionAgent(
  presetKey: string | undefined,
  harnessPresets: Record<string, HarnessPresetSpec>,
  registeredExecutionAgents: ReadonlySet<string>,
  defaultAgent: string,
): string {
  const preset = presetKey ? harnessPresets[presetKey] : undefined;
  if (preset?.tool && registeredExecutionAgents.has(preset.tool)) return preset.tool;
  if (preset?.model && registeredExecutionAgents.has(preset.model)) return preset.model;
  return defaultAgent;
}

export interface GatherWorkflowContextDeps {
  persistence: Pick<PersistenceAdapter, 'loadTasks' | 'getTaskOutput'>;
  conversationRepo: Pick<ConversationRepository, 'loadConversation'>;
  workflowChannelRepo: Pick<WorkflowChannelRepository, 'getByWorkflowId'>;
  agentRegistry: AgentRegistry;
  resolveSession?: typeof resolveAgentSession;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export async function gatherWorkflowContext(
  deps: GatherWorkflowContextDeps,
  workflowId: string,
): Promise<WorkflowContextResult> {
  const { persistence, conversationRepo, workflowChannelRepo, agentRegistry } = deps;
  const resolveSession = deps.resolveSession ?? resolveAgentSession;

  const tasks = persistence.loadTasks(workflowId);
  const contextTasks: WorkflowContextResult['tasks'] = [];
  for (const task of tasks) {
    if (task.config.isMergeNode) continue;
    const sessionId = resolveSessionId({
      id: task.id,
      workflowId,
      runnerKind: '',
      agentSessionId: task.execution.agentSessionId,
      lastAgentSessionId: task.execution.lastAgentSessionId,
      agentName: task.execution.agentName,
      lastAgentName: task.execution.lastAgentName,
    });
    const agentName = resolveAgentName({
      id: task.id,
      workflowId,
      runnerKind: '',
      agentName: task.execution.agentName,
      lastAgentName: task.execution.lastAgentName,
    });
    let transcript: { role: string; content: string }[] = [];
    if (sessionId) {
      try {
        const session = await resolveSession(sessionId, agentName, agentRegistry, tasks);
        transcript = (session?.messages ?? []).map((m) => ({ role: m.role, content: m.content }));
      } catch (err) {
        deps.log?.('warn', `gatherWorkflowContext: session load failed for ${task.id}: ${err}`);
      }
    }
    const output = persistence.getTaskOutput(task.id);
    contextTasks.push({ id: task.id, status: task.status, agentName, transcript, output: output || undefined });
  }

  let planning: { role: string; content: string }[] = [];
  const mapping = workflowChannelRepo.getByWorkflowId(workflowId);
  if (mapping?.lobbyThreadTs) {
    const convo = conversationRepo.loadConversation(mapping.lobbyThreadTs);
    planning = (convo?.messages ?? []).map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));
  }

  return { workflowId, planning, tasks: contextTasks };
}
