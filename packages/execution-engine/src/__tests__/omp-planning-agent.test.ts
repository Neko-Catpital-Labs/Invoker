import { describe, expect, it } from 'vitest';
import { OmpPlanningAgent } from '../agents/omp-planning-agent.js';

describe('OmpPlanningAgent', () => {
  it('builds a print command with auto approve and model selector', () => {
    const agent = new OmpPlanningAgent({ command: 'omp-test' });
    expect(agent.buildPlanningCommand('p', { model: 'claude' })).toEqual({
      command: 'omp-test',
      args: ['--no-title', '--auto-approve', '--model', 'claude', '-p', 'p'],
    });
  });

  it('omits model args when model is absent', () => {
    const agent = new OmpPlanningAgent();
    expect(agent.buildPlanningCommand('p')).toEqual({
      command: 'omp',
      args: ['--no-title', '--auto-approve', '-p', 'p'],
    });
  });
});
