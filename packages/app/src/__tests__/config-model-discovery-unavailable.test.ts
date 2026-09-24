import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn() };
});

import { validateInvokerConfig } from '../config-validation.js';
import type { InvokerConfig } from '../config.js';

const spawnSyncMock = vi.mocked(spawnSync);

function probeFailure() {
  return {
    error: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }),
    status: null,
    signal: null,
    stdout: '',
    stderr: '',
    pid: 0,
    output: [],
  } as unknown as ReturnType<typeof spawnSync>;
}

function probeCatalog(slugs: string[]) {
  return {
    error: undefined,
    status: 0,
    signal: null,
    stdout: JSON.stringify({ models: slugs.map((slug) => ({ slug, display_name: slug })) }),
    stderr: '',
    pid: 0,
    output: [],
  } as unknown as ReturnType<typeof spawnSync>;
}

function rejection(run: () => void): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to throw');
}

describe('validateInvokerConfig with an unavailable Codex CLI', () => {
  let clock = 0;
  let nowSpy: MockInstance<typeof Date.now>;

  beforeEach(() => {
    spawnSyncMock.mockReset();
    clock += 60 * 60_000;
    nowSpy = vi.spyOn(Date, 'now').mockReturnValue(clock);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it('accepts a configured Codex model when every discovery probe fails', () => {
    spawnSyncMock.mockReturnValue(probeFailure());
    const config: InvokerConfig = {
      defaultExecution: { executionAgent: 'codex', executionModel: 'gpt-5.6-luna' },
    };
    expect(() => validateInvokerConfig(config)).not.toThrow();
  });

  it('accepts a flat configured Codex model when every discovery probe fails', () => {
    spawnSyncMock.mockReturnValue(probeFailure());
    const config: InvokerConfig = {
      defaultExecutionAgent: 'codex',
      defaultExecutionModel: 'gpt-5.6-luna',
    };
    expect(() => validateInvokerConfig(config)).not.toThrow();
  });

  it('logs the swallowed discovery error with the agent, model, and probe detail', () => {
    spawnSyncMock.mockReturnValue(probeFailure());
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      validateInvokerConfig({
        defaultExecution: { executionAgent: 'codex', executionModel: 'gpt-5.6-luna' },
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const logged = warnSpy.mock.calls[0].map(String).join(' ');
      expect(logged).toContain('[config-validation]');
      expect(logged).toContain('"codex"');
      expect(logged).toContain('"gpt-5.6-luna"');
      expect(logged).toContain('live probe failed to run (ENOENT)');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not log when discovery succeeds', () => {
    spawnSyncMock.mockReturnValue(probeCatalog(['gpt-5.6-luna', 'gpt-5.5']));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      validateInvokerConfig({
        defaultExecution: { executionAgent: 'codex', executionModel: 'gpt-5.5' },
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('still rejects an invented Codex model when discovery succeeds', () => {
    spawnSyncMock.mockReturnValue(probeCatalog(['gpt-5.6-luna', 'gpt-5.5']));
    const config: InvokerConfig = {
      defaultExecution: { executionAgent: 'codex', executionModel: 'gpt-5.9-invented' },
    };
    expect(rejection(() => validateInvokerConfig(config)).message)
      .toContain('Execution model "gpt-5.9-invented" is not supported for execution agent "codex"');
  });

  it('still accepts a discovered Codex model when discovery succeeds', () => {
    spawnSyncMock.mockReturnValue(probeCatalog(['gpt-5.6-luna', 'gpt-5.5']));
    const config: InvokerConfig = {
      defaultExecution: { executionAgent: 'codex', executionModel: 'gpt-5.5' },
    };
    expect(() => validateInvokerConfig(config)).not.toThrow();
  });

  it('still reports non-model config errors while the Codex CLI is unavailable', () => {
    spawnSyncMock.mockReturnValue(probeFailure());
    const config = {
      defaultExecution: { executionAgent: 'codex', executionModel: 'gpt-5.6-luna' },
      prMaintenance: { targetRepos: ['not-a-repo-slug'] },
    } as unknown as InvokerConfig;
    expect(() => validateInvokerConfig(config)).toThrow(/prMaintenance\.targetRepos/);
  });
});
