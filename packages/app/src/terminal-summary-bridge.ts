import {
  DEFAULT_EXECUTION_AGENT,
  type PersistedTaskMeta,
  type TerminalSpec,
} from '@invoker/execution-engine';
import type { TaskState } from '@invoker/workflow-core';

export const TASK_TERMINAL_SUMMARY_BRIDGE_START = '=== Invoker task terminal bridge ===';
export const TASK_TERMINAL_SUMMARY_BRIDGE_END = '=== End Invoker task terminal bridge ===';

const TASK_TERMINAL_BRIDGE_TEXT_LIMIT = 220;
const TASK_TERMINAL_BRIDGE_PROMPT_LIMIT = 160;

export interface TaskTerminalWorkflowSummary {
  id: string;
  name?: string;
  status?: string;
}

export interface TaskTerminalSummaryBridgeOptions {
  taskId: string;
  status?: string | null;
  task?: TaskState;
  workflow?: TaskTerminalWorkflowSummary;
  meta: PersistedTaskMeta;
  spec?: TerminalSpec;
  cwd?: string;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncatedLine(value: string | undefined | null, limit = TASK_TERMINAL_BRIDGE_TEXT_LIMIT): string {
  const normalized = oneLine(String(value ?? ''));
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function firstPresent(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    const line = truncatedLine(value);
    if (line) return line;
  }
  return undefined;
}

function labelWorkflow(workflow: TaskTerminalWorkflowSummary | undefined, workflowId: string | undefined): string | undefined {
  if (workflow?.name && workflowId) return `${truncatedLine(workflow.name, 96)} (${workflowId})`;
  if (workflow?.name) return truncatedLine(workflow.name, 96);
  return workflowId;
}

function resolveAgentName(
  task: TaskState | undefined,
  meta: PersistedTaskMeta,
): string | undefined {
  return firstPresent(
    meta.executionAgent,
    task?.execution.agentName,
    task?.execution.lastAgentName,
    task?.config.executionAgent,
    meta.agentSessionId ? DEFAULT_EXECUTION_AGENT : undefined,
  );
}

function shouldBuildTaskTerminalBridge(
  task: TaskState | undefined,
  meta: PersistedTaskMeta,
  agentName: string | undefined,
): boolean {
  const commandOnly = Boolean(task?.config.command) && !task?.config.prompt && !task?.config.experimentPrompt;
  const hasAgentContext = Boolean(meta.agentSessionId || agentName || task?.execution.agentSessionId || task?.execution.lastAgentSessionId);
  return hasAgentContext && !(commandOnly && !meta.agentSessionId && !agentName);
}

export function buildTaskTerminalSummaryBridge(
  opts: TaskTerminalSummaryBridgeOptions,
): string | undefined {
  const { task, meta } = opts;
  const agentName = resolveAgentName(task, meta);
  if (!shouldBuildTaskTerminalBridge(task, meta, agentName)) return undefined;

  const workflowId = task?.config.workflowId;
  const workflowLabel = labelWorkflow(opts.workflow, workflowId);
  const branch = firstPresent(meta.branch, task?.execution.branch);
  const workspace = firstPresent(meta.workspacePath, task?.execution.workspacePath, opts.cwd, opts.spec?.cwd);
  const sessionId = firstPresent(meta.agentSessionId, task?.execution.agentSessionId, task?.execution.lastAgentSessionId);
  const taskLine = task?.description
    ? `${opts.taskId} - ${truncatedLine(task.description, 120)}`
    : opts.taskId;

  const lines = [
    TASK_TERMINAL_SUMMARY_BRIDGE_START,
    `Task: ${taskLine}`,
  ];

  if (workflowLabel) lines.push(`Workflow: ${workflowLabel}`);
  lines.push(`Status: ${truncatedLine(task?.status ?? opts.status ?? 'unknown', 64)}`);
  if (agentName) lines.push(`Agent: ${agentName}`);
  if (sessionId) lines.push(`Session: ${sessionId}`);
  if (branch) lines.push(`Branch: ${branch}`);
  if (workspace) lines.push(`Workspace: ${workspace}`);

  const problem = truncatedLine(task?.config.problem);
  const approach = truncatedLine(task?.config.approach);
  const testPlan = truncatedLine(task?.config.testPlan);
  const prompt = truncatedLine(
    firstPresent(task?.execution.inputPrompt, task?.config.prompt, task?.config.experimentPrompt),
    TASK_TERMINAL_BRIDGE_PROMPT_LIMIT,
  );
  const summary = truncatedLine(task?.config.summary);

  if (problem) lines.push(`Problem: ${problem}`);
  if (approach) lines.push(`Approach: ${approach}`);
  if (testPlan) lines.push(`Test plan: ${testPlan}`);
  if (prompt) lines.push(`Prompt: ${prompt}`);
  if (summary) lines.push(`Last summary: ${summary}`);

  const next = sessionId
    ? `Next: Resuming the saved ${agentName ?? 'agent'} session in this terminal.`
    : 'Next: Opening the task workspace in this terminal.';
  lines.push(next, TASK_TERMINAL_SUMMARY_BRIDGE_END, '');
  return `${lines.join('\n')}\n`;
}
