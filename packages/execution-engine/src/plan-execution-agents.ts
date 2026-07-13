/**
 * Plan validation helper — verifies all executionAgent names in a plan are registered.
 */

import { DEFAULT_EXECUTION_AGENT, assertExecutionModelSupported } from './agent.js';
import type { AgentRegistry } from './agent-registry.js';

interface PlanWithAgents {
  tasks: Array<{ id: string; executionAgent?: string; executionModel?: string }>;
}

/**
 * Validate that every task's `executionAgent` (if set) is registered in the agent registry,
 * and that any configured `executionModel` matches the effective execution agent.
 * Throws with a descriptive error listing available agents if validation fails.
 */
export function assertPlanExecutionAgentsRegistered(
  plan: PlanWithAgents,
  registry: AgentRegistry,
): void {
  const available = registry.listExecution().map((a) => a.name);
  const errors: string[] = [];
  for (const task of plan.tasks) {
    const agent = task.executionAgent?.trim();
    if (agent && !registry.get(agent)) {
      errors.push(`Task "${task.id}" references unknown executionAgent "${agent}"`);
      continue;
    }
    const effectiveAgent = agent || DEFAULT_EXECUTION_AGENT;
    try {
      assertExecutionModelSupported(registry.getOrThrow(effectiveAgent), task.executionModel);
    } catch (err) {
      errors.push(`Task "${task.id}" ${(err as Error).message}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `Plan validation failed:\n${errors.join('\n')}\n\nAvailable agents: [${available.join(', ')}]`,
    );
  }
}
