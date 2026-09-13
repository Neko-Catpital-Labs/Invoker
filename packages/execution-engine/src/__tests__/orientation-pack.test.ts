import { describe, expect, it } from 'vitest';
import type { WorkRequest } from '@invoker/contracts';
import { BaseExecutor, type BaseEntry } from '../base-executor.js';
import type { ExecutorHandle, TerminalSpec } from '../executor.js';

class PromptProbeExecutor extends BaseExecutor<BaseEntry> {
  readonly type = 'prompt-probe';

  async start(_request: WorkRequest): Promise<ExecutorHandle> {
    throw new Error('Not implemented');
  }
  async kill(_handle: ExecutorHandle): Promise<void> {}
  sendInput(_handle: ExecutorHandle, _input: string): void {}
  getTerminalSpec(_handle: ExecutorHandle): TerminalSpec | null { return null; }
  getRestoredTerminalSpec(): TerminalSpec { throw new Error('Not implemented'); }
  async destroyAll(): Promise<void> { this.entries.clear(); }

  buildPrompt(request: WorkRequest): string {
    return this.buildFullPrompt(request);
  }
}

function makeFeatureTaskRequest(): WorkRequest {
  return {
    requestId: 'test-request',
    actionId: 'wf-1/implement-orientation',
    executionGeneration: 0,
    actionType: 'ai_task',
    inputs: {
      description: 'Implement the feature task.',
      prompt: 'Add the focused feature change and run the package tests.',
    },
    callbackUrl: '',
    timestamps: { createdAt: new Date('2026-09-13T00:00:00.000Z').toISOString() },
  };
}

describe('worker orientation pack prompt', () => {
  it('injects scoped orientation into default feature tasks without class-search', () => {
    const fullPrompt = new PromptProbeExecutor().buildPrompt(makeFeatureTaskRequest());

    expect(fullPrompt).toContain('Owning package');
    expect(fullPrompt).toContain('Allowed files');
    expect(fullPrompt).toContain('Do not start with an unscoped repository walk');
    expect(fullPrompt).not.toMatch(/class[- ]search|git log --grep|git log --all\b.*-S\b|git log -S|gh pr list --search/i);
  });
});
