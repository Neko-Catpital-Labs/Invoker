import type { PlanningCommandBuilder } from '../../slack/plan-conversation.js';

// Mirrors CodexPlanningAgent.buildPlanningCommand
// (packages/execution-engine/src/agents/codex-planning-agent.ts) so tests
// exercising the default harness preset are backed by the same
// command/args shape a real codex session actually spawns.
export const fakeCodexPlanningCommandBuilder: PlanningCommandBuilder = ({ tool, prompt }) => {
  if (tool !== 'codex') {
    throw new Error(`fakeCodexPlanningCommandBuilder does not support tool "${tool}"`);
  }
  return { command: 'codex', args: ['exec', '--json', '--sandbox', 'workspace-write', prompt] };
};
