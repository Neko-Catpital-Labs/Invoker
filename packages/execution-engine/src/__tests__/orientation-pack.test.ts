import { describe, expect, it } from 'vitest';
import type { WorkRequest, WorkResponse } from '@invoker/contracts';
import { BaseExecutor, type BaseEntry } from '../base-executor.js';
import type { ExecutorHandle, TerminalSpec } from '../executor.js';

class PromptHarnessExecutor extends BaseExecutor<BaseEntry> {
  readonly type = 'prompt-harness';

  async start(_request: WorkRequest): Promise<ExecutorHandle> {
    throw new Error('not implemented');
  }

  async kill(_handle: ExecutorHandle): Promise<void> {}
  sendInput(_handle: ExecutorHandle, _input: string): void {}
  getTerminalSpec(_handle: ExecutorHandle): TerminalSpec | null { return null; }
  getRestoredTerminalSpec(): TerminalSpec { throw new Error('not implemented'); }
  async destroyAll(): Promise<void> { this.entries.clear(); }

  buildPromptForTest(request: WorkRequest): string {
    return this.buildFullPrompt(request);
  }
}

function featureTaskRequest(prompt: string): WorkRequest {
  return {
    requestId: 'orientation-request',
    actionId: 'implement-worker-orientation-pack',
    executionGeneration: 0,
    actionType: 'ai_task',
    inputs: {
      description: 'Inject a worker orientation pack into feature-task prompts',
      prompt,
    },
    callbackUrl: '',
    timestamps: { createdAt: new Date().toISOString() },
  };
}

describe('worker orientation pack', () => {
  it('prepends scoped orientation to default feature-task prompts without class-search', () => {
    const executor = new PromptHarnessExecutor();
    const fullPrompt = executor.buildPromptForTest(featureTaskRequest(
      [
        'Goal: Inject a worker orientation pack into feature-task prompts.',
        'Implementation details: Change packages/execution-engine/src/task-runner-prepare.ts and packages/execution-engine/src/base-executor.ts.',
      ].join('\n'),
    ));

    expect(fullPrompt).toContain('Owning package: packages/execution-engine');
    expect(fullPrompt).toContain('Allowed files: packages/execution-engine/src/task-runner-prepare.ts, packages/execution-engine/src/base-executor.ts');
    expect(fullPrompt).toContain('Do not start with an unscoped repository walk.');
    expect(fullPrompt).not.toMatch(/class[- ]search|git log --grep|git log -S|git log --all\b.*-S\b|gh pr list --search/i);
  });
});
