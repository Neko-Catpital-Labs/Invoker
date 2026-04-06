/**
 * Plan validation helper — verifies all executionAgent names in a plan are registered.
 */

import type { AgentRegistry } from './agent-registry.js';

interface PlanWithAgents {
  tasks: Array<{ id: string; executionAgent?: string }>;
}

/**
 * Validate that every task's `executionAgent` (if set) is registered in the agent registry.
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
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `Plan validation failed:\n${errors.join('\n')}\n\nAvailable agents: [${available.join(', ')}]`,
    );
  }
}
