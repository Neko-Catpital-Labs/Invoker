import { describe, expect, it } from 'vitest';
import type { WorkRequest } from '@invoker/contracts';
import { BaseExecutor, type BaseEntry } from '../base-executor.js';
import type { ExecutorHandle, TerminalSpec } from '../executor.js';

class PromptExecutor extends BaseExecutor<BaseEntry> {
  readonly type = 'prompt-test';

  async start(_request: WorkRequest): Promise<ExecutorHandle> {
    throw new Error('Not implemented');
  }
  sendInput(_handle: ExecutorHandle, _input: string): void {}
  getTerminalSpec(_handle: ExecutorHandle): TerminalSpec | null { return null; }
  getRestoredTerminalSpec(): TerminalSpec { throw new Error('Not implemented'); }
  async destroyAll(): Promise<void> { this.entries.clear(); }

  testBuildFullPrompt(request: WorkRequest): string {
    return this.buildFullPrompt(request);
  }
}

function makeFeatureTaskRequest(overrides: Partial<WorkRequest> = {}): WorkRequest {
  return {
    requestId: 'req-1',
    actionId: 'wf-1/feature-task',
    executionGeneration: 0,
    actionType: 'ai_task',
    inputs: {
      prompt: 'Goal: Add a feature.',
      freshness: {
        watchPaths: [
          'packages/execution-engine/src/task-runner-prepare.ts',
          'packages/execution-engine/src/base-executor.ts',
        ],
      },
      ...overrides.inputs,
    },
    callbackUrl: '',
    timestamps: { createdAt: '2026-09-14T00:00:00.000Z' },
    ...overrides,
  };
}

describe('worker orientation pack', () => {
  it('prepends package and allowed-file orientation without default class-search', () => {
    const prompt = new PromptExecutor().testBuildFullPrompt(makeFeatureTaskRequest());

    expect(prompt).toContain('Owning package: packages/execution-engine');
    expect(prompt).toContain('Allowed files:');
    expect(prompt).toContain('- packages/execution-engine/src/task-runner-prepare.ts');
    expect(prompt).toContain('- packages/execution-engine/src/base-executor.ts');
    expect(prompt).toContain('Do not start with an unscoped repository walk');
    expect(prompt).not.toMatch(/class[- ]search|git log --grep|git log --all\b.*-S\b|git log -S|gh pr list --search/i);
  });
});
