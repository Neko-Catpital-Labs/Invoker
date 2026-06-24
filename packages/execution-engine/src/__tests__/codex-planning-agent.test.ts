import { describe, expect, it } from 'vitest';
import { CodexPlanningAgent } from '../agents/codex-planning-agent.js';

describe('CodexPlanningAgent', () => {
  it('builds a sandboxed full-auto codex exec command and ignores model', () => {
    const agent = new CodexPlanningAgent({ command: 'codex-test' });
    expect(agent.buildPlanningCommand('p', { model: 'ignored' })).toEqual({
      command: 'codex-test',
      args: ['exec', '--json', '--full-auto', 'p'],
    });
  });

  it('defaults the command to codex', () => {
    expect(new CodexPlanningAgent().buildPlanningCommand('p').command).toBe('codex');
  });

  it('bypasses the sandbox only when explicitly configured', () => {
    const agent = new CodexPlanningAgent({ command: 'codex-test', bypassApprovalsAndSandbox: true });
    expect(agent.buildPlanningCommand('p').args).toEqual([
      'exec', '--json', '--dangerously-bypass-approvals-and-sandbox', 'p',
    ]);
  });
});
