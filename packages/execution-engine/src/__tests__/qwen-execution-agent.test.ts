import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { QwenExecutionAgent } from '../agents/qwen-execution-agent.js';

describe('QwenExecutionAgent', () => {
  const previousAuthType = process.env.INVOKER_QWEN_AUTH_TYPE;

  beforeEach(() => {
    delete process.env.INVOKER_QWEN_AUTH_TYPE;
  });

  afterAll(() => {
    if (previousAuthType === undefined) delete process.env.INVOKER_QWEN_AUTH_TYPE;
    else process.env.INVOKER_QWEN_AUTH_TYPE = previousAuthType;
  });
  it('builds prompt command with approval mode and model selector', () => {
    const agent = new QwenExecutionAgent({ command: 'qwen-test' });
    const spec = agent.buildCommand('prompt text', { executionModel: 'qwen3-coder-plus' });

    expect(spec.cmd).toBe('qwen-test');
    expect(spec.args).toEqual([
      '--approval-mode',
      'yolo',
      '--model',
      'qwen3-coder-plus',
      '--prompt',
      'prompt text',
    ]);
    expect(spec.sessionId).toBeDefined();
    expect(spec.fullPrompt).toBe('prompt text');
  });
  it('builds fix command without full prompt echo', () => {
    const agent = new QwenExecutionAgent({ command: 'qwen-test' });
    const spec = agent.buildFixCommand('fix prompt', { executionModel: 'qwen3-coder-plus' });

    expect(spec.cmd).toBe('qwen-test');
    expect(spec.args).toEqual([
      '--approval-mode',
      'yolo',
      '--model',
      'qwen3-coder-plus',
      '--prompt',
      'fix prompt',
    ]);
    expect(spec.sessionId).toBeDefined();
    expect(spec).not.toHaveProperty('fullPrompt');
  });

  it('supports safer approval modes', () => {
    const agent = new QwenExecutionAgent({ command: 'qwen-test', approvalMode: 'auto-edit' });
    expect(agent.buildCommand('prompt text').args).toEqual([
      '--approval-mode',
      'auto-edit',
      '--prompt',
      'prompt text',
    ]);
  });

  it('passes auth type when configured', () => {
    const agent = new QwenExecutionAgent({ command: 'qwen-test', authType: 'openai' });
    expect(agent.buildCommand('prompt text', { executionModel: 'qwen3-coder-plus' }).args).toEqual([
      '--approval-mode',
      'yolo',
      '--auth-type',
      'openai',
      '--model',
      'qwen3-coder-plus',
      '--prompt',
      'prompt text',
    ]);
  });

  it('uses Qwen session id for resume', () => {
    const agent = new QwenExecutionAgent({ command: 'qwen-test' });
    expect(agent.buildResumeArgs('session-123')).toEqual({ cmd: 'qwen-test', args: ['--resume', 'session-123'] });
  });

  it('mounts host Qwen config into containers', () => {
    const agent = new QwenExecutionAgent({ configDir: '/host/.qwen', containerHomePath: '/home/invoker' });
    expect(agent.getContainerRequirements()).toEqual({
      mounts: [{ hostPath: '/host/.qwen', containerPath: '/home/invoker/.qwen' }],
      env: {},
    });
  });
});
