import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OmpExecutionAgent } from '../agents/omp-execution-agent.js';

const ROOT = '/test-omp-sessions';

describe('OmpExecutionAgent', () => {
  it('builds print command with auto approve, isolated session dir, and model selector', () => {
    const agent = new OmpExecutionAgent({ command: 'omp-test', sessionDirRoot: ROOT });
    const spec = agent.buildCommand('prompt text', { executionModel: 'openai/gpt-5.2' });

    expect(spec.cmd).toBe('omp-test');
    expect(spec.args).toEqual([
      '--no-title',
      '--auto-approve',
      '--session-dir',
      join(ROOT, spec.sessionId!),
      '--model',
      'openai/gpt-5.2',
      '-p',
      'prompt text',
    ]);
    expect(spec.sessionId).toBeDefined();
    expect(spec.fullPrompt).toBe('prompt text');
  });

  it('omits model args when executionModel is absent but keeps the session dir', () => {
    const agent = new OmpExecutionAgent({ command: 'omp-test', sessionDirRoot: ROOT });
    const spec = agent.buildCommand('prompt text');
    expect(spec.args).toEqual([
      '--no-title',
      '--auto-approve',
      '--session-dir',
      join(ROOT, spec.sessionId!),
      '-p',
      'prompt text',
    ]);
  });

  it('gives each concurrent build its own session dir so agents do not share a session store', () => {
    const agent = new OmpExecutionAgent({ command: 'omp-test', sessionDirRoot: ROOT });
    const a = agent.buildCommand('a');
    const b = agent.buildCommand('b');
    const c = agent.buildFixCommand('c');

    const dirOf = (args: string[]) => args[args.indexOf('--session-dir') + 1];
    const dirs = [dirOf(a.args), dirOf(b.args), dirOf(c.args)];
    expect(new Set(dirs).size).toBe(3);
    for (const dir of dirs) expect(dir.startsWith(`${ROOT}/`)).toBe(true);
  });

  it('scopes resume to the task session dir instead of a bare --continue', () => {
    const agent = new OmpExecutionAgent({ command: 'omp-test', sessionDirRoot: ROOT });
    expect(agent.buildResumeArgs('session-abc')).toEqual({
      cmd: 'omp-test',
      args: ['--session-dir', join(ROOT, 'session-abc'), '--continue'],
    });
  });

  it('resume targets the same dir the initial command wrote (round-trip via sessionId)', () => {
    const agent = new OmpExecutionAgent({ command: 'omp-test', sessionDirRoot: ROOT });
    const spec = agent.buildCommand('do work');
    // Executor persists spec.sessionId and later passes it back to buildResumeArgs.
    const resume = agent.buildResumeArgs(spec.sessionId!);
    const initialDir = spec.args[spec.args.indexOf('--session-dir') + 1];
    const resumeDir = resume.args[resume.args.indexOf('--session-dir') + 1];
    expect(resumeDir).toBe(initialDir);
  });

  it('defaults the session dir root to a cross-environment temp path', () => {
    const agent = new OmpExecutionAgent({ command: 'omp-test' });
    const spec = agent.buildCommand('prompt');
    expect(spec.args).toContain('--session-dir');
    expect(spec.args[spec.args.indexOf('--session-dir') + 1]).toBe(
      join('/tmp/invoker-omp-sessions', spec.sessionId!),
    );
  });

  it('mounts host OMP agent config into containers (session dir is not a mount)', () => {
    const agent = new OmpExecutionAgent({ configDir: '/host/.omp/agent', containerHomePath: '/home/invoker' });
    expect(agent.getContainerRequirements()).toEqual({
      mounts: [{ hostPath: '/host/.omp/agent', containerPath: '/home/invoker/.omp/agent' }],
      env: {},
    });
  });
});
