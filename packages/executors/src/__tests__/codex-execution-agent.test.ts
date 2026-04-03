import { describe, it, expect } from 'vitest';
import { CodexExecutionAgent } from '../agents/codex-execution-agent.js';

describe('CodexExecutionAgent', () => {
  it('uses default command "codex" with --full-auto', () => {
    const agent = new CodexExecutionAgent();
    const spec = agent.buildCommand('test prompt');
    expect(spec.cmd).toBe('codex');
    expect(spec.args).toEqual(['exec', '--json', '--full-auto', 'test prompt']);
  });

  it('respects custom command', () => {
    const agent = new CodexExecutionAgent({ command: '/usr/bin/codex' });
    const spec = agent.buildCommand('p');
    expect(spec.cmd).toBe('/usr/bin/codex');
  });

  it('buildCommand generates unique session IDs', () => {
    const agent = new CodexExecutionAgent();
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      ids.add(agent.buildCommand('p').sessionId!);
    }
    expect(ids.size).toBe(5);
  });

  it('buildResumeArgs uses interactive resume', () => {
    const agent = new CodexExecutionAgent({ command: 'codex-cli' });
    const resume = agent.buildResumeArgs('sess-123');
    expect(resume.cmd).toBe('codex-cli');
    expect(resume.args).toEqual(['resume', 'sess-123']);
  });

  it('buildFixCommand includes --full-auto', () => {
    const agent = new CodexExecutionAgent();
    const spec = agent.buildFixCommand('fix the bug');
    expect(spec.cmd).toBe('codex');
    expect(spec.args).toEqual(['exec', '--json', '--full-auto', 'fix the bug']);
    expect(spec.sessionId).toBeDefined();
  });

  it('buildFixCommand generates unique session IDs', () => {
    const agent = new CodexExecutionAgent();
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      ids.add(agent.buildFixCommand('p').sessionId!);
    }
    expect(ids.size).toBe(5);
  });

  it('has correct readonly properties', () => {
    const agent = new CodexExecutionAgent();
    expect(agent.name).toBe('codex');
    expect(agent.stdinMode).toBe('ignore');
    expect(agent.linuxTerminalTail).toBe('exec_bash');
  });
});
