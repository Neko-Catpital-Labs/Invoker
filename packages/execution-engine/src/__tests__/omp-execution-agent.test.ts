import { describe, expect, it } from 'vitest';
import { OmpExecutionAgent } from '../agents/omp-execution-agent.js';

describe('OmpExecutionAgent', () => {
  it('builds print command with auto approve and model selector', () => {
    const agent = new OmpExecutionAgent({ command: 'omp-test' });
    const spec = agent.buildCommand('prompt text', { executionModel: 'openai/gpt-5.2' });

    expect(spec.cmd).toBe('omp-test');
    expect(spec.args).toEqual([
      '--no-title',
      '--auto-approve',
      '--model',
      'openai/gpt-5.2',
      '-p',
      'prompt text',
    ]);
    expect(spec.sessionId).toBeDefined();
    expect(spec.fullPrompt).toBe('prompt text');
  });

  it('omits model args when executionModel is absent', () => {
    const agent = new OmpExecutionAgent({ command: 'omp-test' });
    expect(agent.buildCommand('prompt text').args).toEqual([
      '--no-title',
      '--auto-approve',
      '-p',
      'prompt text',
    ]);
  });

  it('uses cwd-local continue for resume', () => {
    const agent = new OmpExecutionAgent({ command: 'omp-test' });
    expect(agent.buildResumeArgs('ignored-session')).toEqual({ cmd: 'omp-test', args: ['--continue'] });
  });

  it('mounts host OMP agent config into containers', () => {
    const agent = new OmpExecutionAgent({ configDir: '/host/.omp/agent', containerHomePath: '/home/invoker' });
    expect(agent.getContainerRequirements()).toEqual({
      mounts: [{ hostPath: '/host/.omp/agent', containerPath: '/home/invoker/.omp/agent' }],
      env: {},
    });
  });
});
