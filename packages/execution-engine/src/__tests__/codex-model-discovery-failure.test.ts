import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionModelOption } from '../agent.js';
import { CodexExecutionAgent } from '../agents/codex-execution-agent.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

type ModelDiscoveryResult =
  | { kind: 'success'; models: readonly ExecutionModelOption[] }
  | { kind: 'failed' };

type ModelDiscoveryTestAccess = {
  discoverSupportedModels(): ModelDiscoveryResult;
};

function discoverSupportedModels(agent: CodexExecutionAgent): ModelDiscoveryResult {
  return (agent as unknown as ModelDiscoveryTestAccess).discoverSupportedModels();
}

function stubProbe(status: number, stdout: string): void {
  vi.mocked(spawnSync).mockReturnValue({
    status,
    stdout,
    stderr: '',
    output: [],
    pid: 1,
    signal: null,
  } as any);
}

describe('CodexExecutionAgent model discovery outcomes', () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
  });

  it('represents a failed probe distinctly and falls back at the call site', () => {
    stubProbe(1, '');
    const agent = new CodexExecutionAgent();

    expect(discoverSupportedModels(agent)).toEqual({ kind: 'failed' });
    expect(agent.supportedModels).not.toEqual([]);
  });

  it('represents a successful probe with zero entries distinctly and preserves the empty result', () => {
    stubProbe(0, JSON.stringify({ models: [] }));
    const agent = new CodexExecutionAgent();

    expect(discoverSupportedModels(agent)).toEqual({ kind: 'success', models: [] });
    expect(agent.supportedModels).toEqual([]);
  });
});
