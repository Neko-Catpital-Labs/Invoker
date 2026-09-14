import { describe, expect, it } from 'vitest';
import type { WorkRequest } from '@invoker/contracts';
import { BaseExecutor, type BaseEntry } from '../base-executor.js';
import type { ExecutorHandle, PersistedTaskMeta, TerminalSpec } from '../executor.js';

class PromptHarnessExecutor extends BaseExecutor<BaseEntry> {
  readonly type = 'prompt-harness';

  exposeBuildFullPrompt(request: WorkRequest): string {
    return this.buildFullPrompt(request);
  }

  async start(): Promise<ExecutorHandle> {
    throw new Error('not used');
  }

  sendInput(): void {}

  getTerminalSpec(): TerminalSpec | null {
    return null;
  }

  getRestoredTerminalSpec(_meta: PersistedTaskMeta): TerminalSpec {
    throw new Error('not used');
  }

  async destroyAll(): Promise<void> {}
}

function makeFeatureTaskRequest(): WorkRequest {
  return {
    requestId: 'req-1',
    actionId: 'wf-1/implement-worker-orientation-pack',
    executionGeneration: 0,
    actionType: 'ai_task',
    inputs: {
      description: 'Inject a worker orientation pack into feature-task prompts',
      prompt: 'Implement the behavior change and tests.',
      executionAgent: 'claude',
      baseBranch: 'main',
    },
    callbackUrl: '',
    timestamps: { createdAt: '2026-09-13T00:00:00.000Z' },
  };
}

describe('worker orientation pack prompt', () => {
  it('prepends scoped orientation without default class-search guidance', () => {
    const executor = new PromptHarnessExecutor();
    const prompt = executor.exposeBuildFullPrompt(makeFeatureTaskRequest());

    expect(prompt).toContain('Owning package');
    expect(prompt).toContain('Allowed files');
    expect(prompt).toContain('Do not start with an unscoped repository walk');
    expect(prompt).not.toMatch(/class[- ]search/i);
    expect(prompt).toContain('Implement the behavior change and tests.');
  });
});
