import { describe, expect, it } from 'vitest';
import { KimiExecutionAgent } from '../agents/kimi-execution-agent.js';

describe('KimiExecutionAgent', () => {
  it('builds prompt command with yolo and model selector', () => {
    const agent = new KimiExecutionAgent({ command: 'kimi-test' });
    const spec = agent.buildCommand('prompt text', { executionModel: 'kimi-k2.6' });

    expect(spec.cmd).toBe('kimi-test');
    expect(spec.args).toEqual([
      '--yolo',
      '--model',
      'kimi-k2.6',
      '-p',
      'prompt text',
    ]);
    expect(spec.sessionId).toBeDefined();
    expect(spec.fullPrompt).toBe('prompt text');
  });
  it('builds fix command without full prompt echo', () => {
    const agent = new KimiExecutionAgent({ command: 'kimi-test' });
    const spec = agent.buildFixCommand('fix prompt', { executionModel: 'kimi-k2.6' });

    expect(spec.cmd).toBe('kimi-test');
    expect(spec.args).toEqual([
      '--yolo',
      '--model',
      'kimi-k2.6',
      '-p',
      'fix prompt',
    ]);
    expect(spec.sessionId).toBeDefined();
    expect(spec).not.toHaveProperty('fullPrompt');
  });

  it('can disable yolo for stricter local runs', () => {
    const agent = new KimiExecutionAgent({ command: 'kimi-test', yolo: false });
    expect(agent.buildCommand('prompt text').args).toEqual([
      '-p',
      'prompt text',
    ]);
  });

  it('uses Kimi session id for resume', () => {
    const agent = new KimiExecutionAgent({ command: 'kimi-test' });
    expect(agent.buildResumeArgs('session-123')).toEqual({ cmd: 'kimi-test', args: ['--session', 'session-123'] });
  });

  it('mounts host Kimi config into containers', () => {
    const agent = new KimiExecutionAgent({ configDir: '/host/.kimi-code', containerHomePath: '/home/invoker' });
    expect(agent.getContainerRequirements()).toEqual({
      mounts: [{ hostPath: '/host/.kimi-code', containerPath: '/home/invoker/.kimi-code' }],
      env: {},
    });
  });
});
