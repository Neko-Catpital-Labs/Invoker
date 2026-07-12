export interface AgentCommandSpec {
  cmd: string;
  args: string[];
  sessionId?: string;
  fullPrompt?: string;
}

export interface AgentCommandBuildOptions {
  executionModel?: string;
}
export interface ExecutionModelOption {
  id: string;
  label: string;
}


export const DEFAULT_EXECUTION_AGENT = 'codex';

export interface ExecutionAgent {
  readonly name: string;
  readonly stdinMode: 'ignore' | 'pipe';
  readonly linuxTerminalTail?: 'exec_bash' | 'pause';
  readonly bundledSkillRoot?: string;
  readonly bundledSkills?: readonly string[];
  readonly supportedModels?: readonly ExecutionModelOption[];
  supportsModel?(executionModel: string): boolean;
  buildCommand(fullPrompt: string, options?: AgentCommandBuildOptions): AgentCommandSpec;
  buildResumeArgs(sessionId: string): { cmd: string; args: string[] };
  buildFixCommand?(prompt: string, options?: AgentCommandBuildOptions): AgentCommandSpec;
  getContainerRequirements?(): {
    mounts: Array<{ hostPath: string; containerPath: string; readonly?: boolean }>;
    env: Record<string, string>;
  };
}

export function assertExecutionModelSupported(
  agent: Pick<ExecutionAgent, 'name' | 'supportedModels' | 'supportsModel'>,
  executionModel: string | null | undefined,
): void {
  const normalizedModel = executionModel?.trim();
  if (!normalizedModel) return;
  if (agent.supportedModels?.some((candidate) => candidate.id === normalizedModel)) return;
  if (agent.supportsModel?.(normalizedModel)) return;
  const supported = agent.supportedModels?.map((candidate) => candidate.id) ?? [];
  const hint = supported.length > 0 ? ` Known models: [${supported.join(', ')}].` : '';
  throw new Error(`Execution model "${normalizedModel}" is not supported for execution agent "${agent.name}".${hint}`);
}

export interface PlanningAgent {
  readonly name: string;
  buildPlanningCommand(
    prompt: string,
    options?: { model?: string },
  ): { command: string; args: string[] };
}
