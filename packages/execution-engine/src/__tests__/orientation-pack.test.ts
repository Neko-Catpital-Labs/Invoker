import { describe, expect, it } from 'vitest';
import type { WorkRequest } from '@invoker/contracts';
import { BaseExecutor, type BaseEntry } from '../base-executor.js';
import type { ExecutorHandle, TerminalSpec } from '../executor.js';

class PromptProbeExecutor extends BaseExecutor<BaseEntry> {
  readonly type = 'prompt-probe';

  async start(_request: WorkRequest): Promise<ExecutorHandle> {
    throw new Error('Not implemented');
  }
  sendInput(_handle: ExecutorHandle, _input: string): void {}
  getTerminalSpec(_handle: ExecutorHandle): TerminalSpec | null { return null; }
  getRestoredTerminalSpec(): TerminalSpec { throw new Error('Not implemented'); }
  async destroyAll(): Promise<void> { this.entries.clear(); }

  promptFor(request: WorkRequest): string {
    return this.buildFullPrompt(request);
  }
}

function makeAiTaskRequest(prompt: string): WorkRequest {
  return {
    requestId: 'req-orientation',
    actionId: 'packages/execution-engine/add-orientation-pack',
    executionGeneration: 0,
    actionType: 'ai_task',
    inputs: {
      description: 'Inject a worker orientation pack into feature-task prompts',
      prompt,
    },
    callbackUrl: '',
    timestamps: {
      createdAt: '2026-09-15T00:00:00.000Z',
    },
  };
}

describe('worker orientation pack prompts', () => {
  it('prepends scoped orientation and does not inject class-search for default feature tasks', () => {
    const prompt = new PromptProbeExecutor().promptFor(makeAiTaskRequest([
      'Goal: Add a typed task summary field.',
      'Implementation details: Touch the execution-engine task runner only.',
    ].join('\n')));

    expect(prompt).toContain('Owning package');
    expect(prompt).toContain('Allowed files');
    expect(prompt).toContain('Do not start with an unscoped repository walk');
    expect(prompt).not.toMatch(/class[- ]search|git log --grep|git log -S|gh pr list --search/i);
  });
});
