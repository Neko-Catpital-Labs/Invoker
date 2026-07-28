import { describe, expect, it } from 'vitest';
import { assertExecutionModelSupported } from '../agent.js';
import { CursorExecutionAgent } from '../agents/cursor-execution-agent.js';

describe('CursorExecutionAgent', () => {
  it('builds prompt command with print/trust and model selector', () => {
    const agent = new CursorExecutionAgent({ command: 'cursor-test' });
    const spec = agent.buildCommand('prompt text', { executionModel: 'grok-4.5' });

    expect(spec.cmd).toBe('cursor-test');
    expect(spec.args).toEqual([
      'agent',
      '--print',
      '--trust',
      '--model',
      'grok-4.5',
      'prompt text',
    ]);
    expect(spec.sessionId).toBeDefined();
    expect(spec.fullPrompt).toBe('prompt text');
  });

  it('builds fix command without full prompt echo', () => {
    const agent = new CursorExecutionAgent({ command: 'cursor-test' });
    const spec = agent.buildFixCommand('fix prompt', { executionModel: 'grok-4.5' });

    expect(spec.cmd).toBe('cursor-test');
    expect(spec.args).toEqual([
      'agent',
      '--print',
      '--trust',
      '--model',
      'grok-4.5',
      'fix prompt',
    ]);
    expect(spec).not.toHaveProperty('fullPrompt');
  });

  it('omits the model flag when no model is given', () => {
    const agent = new CursorExecutionAgent({ command: 'cursor-test' });
    expect(agent.buildCommand('prompt text').args).toEqual(['agent', '--print', '--trust', 'prompt text']);
  });

  it('supports grok-4.5 and rejects unknown models', () => {
    const agent = new CursorExecutionAgent();
    expect(() => assertExecutionModelSupported(agent, 'grok-4.5')).not.toThrow();
    expect(() => assertExecutionModelSupported(agent, 'gpt-5-codex')).toThrow(
      /not supported for execution agent "cursor"/,
    );
  });

  it('uses agent --resume for resume args', () => {
    const agent = new CursorExecutionAgent({ command: 'cursor-test' });
    expect(agent.buildResumeArgs('session-123')).toEqual({
      cmd: 'cursor-test',
      args: ['agent', '--resume', 'session-123'],
    });
  });

  it('defaults to the "cursor" command', () => {
    const agent = new CursorExecutionAgent();
    expect(agent.buildCommand('prompt').cmd).toBe('cursor');
  });
});
