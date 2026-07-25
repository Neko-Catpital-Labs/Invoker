import { ExecutionHarnessSessionDriver, ReplayHarnessSessionDriver } from '@invoker/execution-engine';
import type { ExecutionAgent, HarnessSessionDriver } from '@invoker/execution-engine';
import type { PlanningCommandBuilder } from './plan-conversation.js';

export interface HarnessPresetLike {
  tool: string;
  model?: string;
}

export interface HarnessSessionDriverDeps {
  /** Looks up a registered execution agent (claude/codex/omp) by harness tool name. */
  executionAgentRegistry?: { get(name: string): ExecutionAgent | undefined };
  /** Builds the planner CLI command for harnesses without real session resume (e.g. cursor). */
  planningCommandBuilder?: PlanningCommandBuilder;
}

/** Picks an ExecutionHarnessSessionDriver for tools with a registered execution agent, else a ReplayHarnessSessionDriver, else undefined. */
export function selectHarnessSessionDriver(
  preset: HarnessPresetLike,
  deps: HarnessSessionDriverDeps,
): HarnessSessionDriver | undefined {
  const agent = deps.executionAgentRegistry?.get(preset.tool);
  if (agent) {
    return new ExecutionHarnessSessionDriver(agent);
  }
  if (!deps.planningCommandBuilder) return undefined;
  const planningCommandBuilder = deps.planningCommandBuilder;
  return new ReplayHarnessSessionDriver(preset.tool, (prompt, options) =>
    planningCommandBuilder({ tool: preset.tool, model: options?.model ?? preset.model, prompt }));
}
