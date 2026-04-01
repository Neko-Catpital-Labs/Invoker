import { describe, it, expect } from 'vitest';
import { CodexExecutionAgent } from '../agents/codex-execution-agent.js';

describe('CodexExecutionAgent', () => {
  it('uses default command "codex" and fullAuto=true', () => {
    const agent = new CodexExecutionAgent();
    const spec = agent.buildCommand('test prompt');
    expect(spec.cmd).toBe('codex');
    expect(spec.args).toContain('exec');
    expect(spec.args).toContain('--full-auto');
    expect(spec.args).toContain('test prompt');
  });

  it('respects custom command', () => {
    const agent = new CodexExecutionAgent({ command: '/usr/bin/codex' });
    const spec = agent.buildCommand('p');
    expect(spec.cmd).toBe('/usr/bin/codex');
  });

  it('omits --full-auto when fullAuto is false', () => {
    const agent = new CodexExecutionAgent({ fullAuto: false });
    const spec = agent.buildCommand('prompt');
    expect(spec.args).not.toContain('--full-auto');
    expect(spec.args).toContain('exec');
    expect(spec.args).toContain('prompt');
  });

  it('buildCommand generates unique session IDs', () => {
    const agent = new CodexExecutionAgent();
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      ids.add(agent.buildCommand('p').sessionId!);
    }
    expect(ids.size).toBe(5);
  });

  it('buildResumeArgs uses exec resume <sessionId>', () => {
    const agent = new CodexExecutionAgent({ command: 'codex-cli' });
    const resume = agent.buildResumeArgs('sess-123');
    expect(resume.cmd).toBe('codex-cli');
    expect(resume.args).toEqual(['exec', 'resume', 'sess-123']);
  });

  it('buildFixCommand includes --full-auto when enabled', () => {
    const agent = new CodexExecutionAgent();
    const spec = agent.buildFixCommand('fix the bug');
    expect(spec.cmd).toBe('codex');
    expect(spec.args).toContain('exec');
    expect(spec.args).toContain('--full-auto');
    expect(spec.args).toContain('fix the bug');
    expect(spec.sessionId).toBeDefined();
  });

  it('buildFixCommand omits --full-auto when disabled', () => {
    const agent = new CodexExecutionAgent({ fullAuto: false });
    const spec = agent.buildFixCommand('fix the bug');
    expect(spec.args).not.toContain('--full-auto');
    expect(spec.args).toEqual(['exec', 'fix the bug']);
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
