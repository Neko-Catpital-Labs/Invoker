import { describe, expect, it } from 'vitest';
import { ClaudePlanningAgent } from '../agents/claude-planning-agent.js';

describe('ClaudePlanningAgent', () => {
  it('builds a print-mode command with permissions skipped', () => {
    const agent = new ClaudePlanningAgent({ command: 'claude-test' });
    expect(agent.buildPlanningCommand('p')).toEqual({
      command: 'claude-test',
      args: ['--dangerously-skip-permissions', '-p', 'p'],
    });
  });

  it('defaults the command to claude', () => {
    expect(new ClaudePlanningAgent().buildPlanningCommand('p').command).toBe('claude');
  });

  it('inserts --model before -p when a model is given', () => {
    const agent = new ClaudePlanningAgent({ command: 'claude-test' });
    expect(agent.buildPlanningCommand('p', { model: 'opus' }).args).toEqual([
      '--dangerously-skip-permissions', '--model', 'opus', '-p', 'p',
    ]);
  });
});
