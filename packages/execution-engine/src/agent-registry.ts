/**
 * AgentRegistry — Registry for pluggable AI agents.
 *
 * Maps agent names to ExecutionAgent / PlanningAgent instances.
 * Executors look up agents by name (e.g. 'claude') at task execution time.
 */

import type { ExecutionAgent, PlanningAgent } from './agent.js';
import type { SessionDriver } from './session-driver.js';

export class AgentRegistry {
  private executionAgents = new Map<string, ExecutionAgent>();
  private planningAgents = new Map<string, PlanningAgent>();
  private sessionDrivers = new Map<string, SessionDriver>();

  registerExecution(agent: ExecutionAgent, sessionDriver?: SessionDriver): void {
    this.executionAgents.set(agent.name, agent);
    if (sessionDriver) {
      this.sessionDrivers.set(agent.name, sessionDriver);
    }
  }

  getSessionDriver(agentName: string): SessionDriver | undefined {
    return this.sessionDrivers.get(agentName);
  }

  registerPlanning(agent: PlanningAgent): void {
    this.planningAgents.set(agent.name, agent);
  }

  get(name: string): ExecutionAgent | undefined {
    return this.executionAgents.get(name);
  }

  getOrThrow(name: string): ExecutionAgent {
    const agent = this.executionAgents.get(name);
    if (!agent) {
      throw new Error(`No execution agent registered with name "${name}". Available: [${[...this.executionAgents.keys()].join(', ')}]`);
    }
    return agent;
  }

  getPlanning(name: string): PlanningAgent | undefined {
    return this.planningAgents.get(name);
  }

  getPlanningOrThrow(name: string): PlanningAgent {
    const agent = this.planningAgents.get(name);
    if (!agent) {
      throw new Error(`No planning agent registered with name "${name}". Available: [${[...this.planningAgents.keys()].join(', ')}]`);
    }
    return agent;
  }

  /**
   * Look up an execution agent whose `name` matches a terminal spec command.
   * Returns undefined if no agent matches.
   */
  getByCommand(command: string): ExecutionAgent | undefined {
    for (const agent of this.executionAgents.values()) {
      if (agent.name === command) return agent;
    }
    return undefined;
  }

  listExecution(): ExecutionAgent[] {
    return [...this.executionAgents.values()];
  }

  listPlanning(): PlanningAgent[] {
    return [...this.planningAgents.values()];
  }
}
