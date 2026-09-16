import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertExecutionModelSupported } from '../agent.js';
import { CodexExecutionAgent } from '../agents/codex-execution-agent.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

const luna = { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6 Luna' };
const catalog = JSON.stringify({ models: [luna] });
const command = '/custom/codex';

function probe(overrides: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
  return {
    status: 0,
    stdout: catalog,
    stderr: '',
    output: [],
    pid: 1,
    signal: null,
    ...overrides,
  };
}

function expectProbes(bundled: boolean): void {
  const options = { encoding: 'utf8', timeout: 3_000, killSignal: 'SIGKILL' };
  expect(spawnSync).toHaveBeenNthCalledWith(1, command, ['debug', 'models'], options);
  if (bundled) {
    expect(spawnSync).toHaveBeenNthCalledWith(2, command, ['debug', 'models', '--bundled'], options);
  }
  expect(spawnSync).toHaveBeenCalledTimes(bundled ? 2 : 1);
}

function expectLuna(agent: CodexExecutionAgent): void {
  expect(agent.supportedModels).toEqual([{ id: luna.slug, label: luna.display_name }]);
  expect(agent.supportsModel(' GPT-5.6-LUNA ')).toBe(true);
  expect(() => assertExecutionModelSupported(agent, ' GPT-5.6-LUNA ')).not.toThrow();
  expect(agent.supportsModel('invented-model')).toBe(false);
  expect(() => assertExecutionModelSupported(agent, 'invented-model')).toThrow(
    'Execution model "invented-model" is not supported for execution agent "codex". Known models: [gpt-5.6-luna].',
  );
  expect(agent.supportedModelsProvenance).toBe('agent');
}

const invalidCatalogs = [
  ['malformed JSON', '{secret-catalog-payload'],
  ['null root', 'null'],
  ['absent models', '{}'],
  ['non-array models', '{"models":{}}'],
  ['null models', '{"models":null}'],
  ['null entry', '{"models":[null]}'],
  ['primitive entry', '{"models":[42]}'],
  ['absent slug', '{"models":[{"display_name":"Luna"}]}'],
  ['non-string slug', '{"models":[{"slug":42,"display_name":"Luna"}]}'],
  ['blank slug', '{"models":[{"slug":"  ","display_name":"Luna"}]}'],
  ['absent display_name', '{"models":[{"slug":"gpt-5.6-luna"}]}'],
  ['non-string display_name', '{"models":[{"slug":"gpt-5.6-luna","display_name":42}]}'],
  ['blank display_name', '{"models":[{"slug":"gpt-5.6-luna","display_name":"  "}]}'],
  ['invalid entry after valid entry', JSON.stringify({ models: [luna, { slug: 'bad' }] })],
] as const;

describe('CodexExecutionAgent model discovery outcomes', () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses healthy live output with one bounded probe and reuses its successful cache', () => {
    vi.mocked(spawnSync).mockReturnValue(probe());
    const agent = new CodexExecutionAgent({ command });

    expectLuna(agent);
    expectLuna(agent);
    expectProbes(false);
  });

  it.each([
    ['nonzero exit', probe({ status: 23, stdout: '' })],
    ['timeout', probe({ status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) })],
  ])('uses the same binary bundled catalog after live %s and caches the result', (_name, failure) => {
    vi.mocked(spawnSync).mockReturnValueOnce(failure).mockReturnValue(probe());
    const agent = new CodexExecutionAgent({ command });

    expectLuna(agent);
    expectLuna(agent);
    expectProbes(true);
  });

  it('represents total probe failure as unavailable rather than an unsupported model', () => {
    vi.mocked(spawnSync).mockReturnValue(probe({ status: 23, stdout: '' }));
    const agent = new CodexExecutionAgent({ command });

    expect(() => agent.supportedModels).toThrow(/Codex model discovery unavailable.*live.*status=23.*bundled.*status=23/);
    expectProbes(true);
    expect(() => agent.supportsModel(luna.slug)).toThrow('Codex model discovery unavailable');
    expect(() => assertExecutionModelSupported(agent, luna.slug)).toThrow('Codex model discovery unavailable');
  });

  it('preserves a valid empty live result as authoritative without bundled fallback', () => {
    vi.mocked(spawnSync).mockReturnValue(probe({ stdout: '{"models":[]}' }));
    const agent = new CodexExecutionAgent({ command });

    expect(agent.supportedModels).toEqual([]);
    expect(agent.supportsModel(luna.slug)).toBe(false);
    expect(() => assertExecutionModelSupported(agent, luna.slug)).toThrow('is not supported');
    expect(agent.supportedModelsProvenance).toBe('agent');
    expectProbes(false);
  });

  it.each(invalidCatalogs)('falls back for live %s', (_name, stdout) => {
    vi.mocked(spawnSync).mockReturnValueOnce(probe({ stdout })).mockReturnValue(probe());
    const agent = new CodexExecutionAgent({ command });

    expectLuna(agent);
    expectProbes(true);
  });

  it.each(invalidCatalogs)('reports bundled %s as failure rather than successful emptiness', (_name, stdout) => {
    vi.mocked(spawnSync).mockReturnValueOnce(probe({ status: 23 })).mockReturnValue(probe({ stdout }));
    const agent = new CodexExecutionAgent({ command });

    expect(() => assertExecutionModelSupported(agent, luna.slug)).toThrow(
      /Codex model discovery unavailable.*live.*status=23.*bundled.*(?:JSON|models)/,
    );
    expectProbes(true);
  });

  it.each([false, true])('preserves schema mapping, trimming and first case-insensitive duplicate (bundled=%s)', (bundled) => {
    if (bundled) vi.mocked(spawnSync).mockReturnValueOnce(probe({ status: 23 }));
    vi.mocked(spawnSync).mockReturnValue(probe({ stdout: JSON.stringify({
      fetched_at: '2026-09-15',
      models: [
        { slug: ' GPT-5.6-Luna ', display_name: ' GPT-5.6 Luna ', priority: 1, supported_reasoning_levels: [] },
        { slug: 'gpt-5.6-luna', display_name: 'Duplicate label' },
        { slug: 'gpt-5.5', display_name: 'GPT-5.5', hidden: false },
      ],
    }) }));
    const agent = new CodexExecutionAgent({ command });

    expect(agent.supportedModels).toEqual([
      { id: 'GPT-5.6-Luna', label: 'GPT-5.6 Luna' },
      { id: 'gpt-5.5', label: 'GPT-5.5' },
    ]);
    expect(() => assertExecutionModelSupported(agent, 'gpt-5.6-luna')).not.toThrow();
    expectProbes(bundled);
  });

  it('accepts and caches a valid empty bundled catalog', () => {
    vi.mocked(spawnSync).mockReturnValueOnce(probe({ status: 23 })).mockReturnValue(probe({ stdout: '{"models":[]}' }));
    const agent = new CodexExecutionAgent({ command });

    expect(agent.supportedModels).toEqual([]);
    expect(agent.supportsModel(luna.slug)).toBe(false);
    expect(agent.supportedModelsProvenance).toBe('agent');
    expectProbes(true);
  });

  it('preserves both subprocess diagnostics without exposing raw payloads or error messages', () => {
    const secret = 'secret-credential-do-not-print';
    vi.mocked(spawnSync)
      .mockReturnValueOnce(probe({ status: null, signal: 'SIGKILL', error: Object.assign(new Error(secret.repeat(1000)), { code: 'ETIMEDOUT' }), stdout: secret, stderr: secret }))
      .mockReturnValue(probe({ status: 2, stdout: secret, stderr: `unexpected argument --bundled ${secret}` }));
    const agent = new CodexExecutionAgent({ command });

    let failure: unknown;
    try {
      agent.supportedModels;
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error('Expected discovery to be unavailable');
    expect(failure.message).toMatch(/live.*ETIMEDOUT.*SIGKILL.*bundled.*status=2/);
    expect(failure.message).not.toContain(secret);
    expect(failure.message.length).toBeLessThan(1000);
    expectProbes(true);
  });

  it('reports a missing CLI binary for both attempts', () => {
    vi.mocked(spawnSync).mockReturnValue(probe({ status: null, error: Object.assign(new Error('missing binary'), { code: 'ENOENT' }) }));
    const agent = new CodexExecutionAgent({ command });

    expect(() => assertExecutionModelSupported(agent, luna.slug)).toThrow(/unavailable.*live.*ENOENT.*bundled.*ENOENT/);
    expectProbes(true);
  });

  it('reports malformed live and bundled JSON without including their payloads', () => {
    vi.mocked(spawnSync).mockReturnValue(probe({ stdout: '{secret-catalog-payload' }));
    const agent = new CodexExecutionAgent({ command });

    expect(() => agent.supportedModels).toThrow(/unavailable.*live.*invalid JSON.*bundled.*invalid JSON/);
    expect(() => agent.supportedModels).not.toThrow(/secret-catalog-payload/);
  });

  it('refreshes successful discovery after the existing five-minute cache lifetime', () => {
    vi.useFakeTimers();
    vi.mocked(spawnSync).mockReturnValueOnce(probe()).mockReturnValue(probe({ stdout: '{"models":[]}' }));
    const agent = new CodexExecutionAgent({ command });

    expectLuna(agent);
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expectLuna(agent);
    expectProbes(false);
    vi.advanceTimersByTime(1);
    expect(agent.supportedModels).toEqual([]);
    expect(spawnSync).toHaveBeenCalledTimes(2);
    expect(vi.mocked(spawnSync).mock.calls[1]?.[1]).toEqual(['debug', 'models']);
  });
});
