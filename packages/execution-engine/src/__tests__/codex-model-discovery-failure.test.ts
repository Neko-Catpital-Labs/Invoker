import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertExecutionModelSupported, type ExecutionModelOption } from '../agent.js';
import { CodexExecutionAgent } from '../agents/codex-execution-agent.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

type CodexCatalogSource = 'live' | 'bundled';

type ModelDiscoveryResult =
  | { kind: 'success'; source: CodexCatalogSource; models: readonly ExecutionModelOption[] }
  | { kind: 'unavailable'; attempts: ReadonlyArray<{ source: CodexCatalogSource; detail: string }> };

type ModelDiscoveryTestAccess = {
  discoverSupportedModels(): ModelDiscoveryResult;
};

function discoverSupportedModels(agent: CodexExecutionAgent): ModelDiscoveryResult {
  return (agent as unknown as ModelDiscoveryTestAccess).discoverSupportedModels();
}

const LIVE_CATALOG_ENTRIES = [
  { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra' },
  { slug: 'gpt-reserve', display_name: 'GPT-Reserve' },
  { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol' },
  { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra' },
  { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna' },
  { slug: 'gpt-5.5', display_name: 'GPT-5.5' },
  { slug: 'codex-auto-review', display_name: 'Codex Auto Review' },
];

const BUNDLED_CATALOG_ENTRIES = [
  { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra' },
  { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol' },
  { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra' },
  { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna' },
  { slug: 'gpt-daybreak-blue-latest', display_name: 'Daybreak Blue' },
  { slug: 'gpt-daybreak-red-latest', display_name: 'Daybreak Red' },
  { slug: 'gpt-5.5', display_name: 'GPT-5.5' },
  { slug: 'gpt-5.4', display_name: 'GPT-5.4' },
  { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini' },
  { slug: 'gpt-5.2', display_name: 'GPT-5.2' },
  { slug: 'codex-auto-review', display_name: 'Codex Auto Review' },
];

function catalog(entries: readonly unknown[]): string {
  return JSON.stringify({ models: entries });
}

function expectedOptions(entries: ReadonlyArray<{ slug: string; display_name: string }>): ExecutionModelOption[] {
  return entries.map((entry) => ({ id: entry.slug, label: entry.display_name }));
}

function probe(overrides: Partial<SpawnSyncReturns<string>>): SpawnSyncReturns<string> {
  return {
    status: 0,
    stdout: '',
    stderr: '',
    output: [],
    pid: 1,
    signal: null,
    ...overrides,
  } as SpawnSyncReturns<string>;
}

function stubProbes(...results: Array<Partial<SpawnSyncReturns<string>>>): void {
  for (const result of results) {
    vi.mocked(spawnSync).mockReturnValueOnce(probe(result) as never);
  }
}

function stubProbesBySource(bySource: Record<CodexCatalogSource, Partial<SpawnSyncReturns<string>>>): void {
  vi.mocked(spawnSync).mockImplementation(((_command: string, args: readonly string[]) =>
    probe(bySource[args.includes('--bundled') ? 'bundled' : 'live'])) as never);
}

function bundledProbeCount(): number {
  return vi.mocked(spawnSync).mock.calls
    .filter((call) => (call[1] as string[]).includes('--bundled')).length;
}

function spawnError(code: string): SpawnSyncReturns<string>['error'] {
  return Object.assign(new Error(`spawnSync codex ${code}`), { code });
}

function probeArgs(call: number): string[] {
  return vi.mocked(spawnSync).mock.calls[call]![1] as string[];
}

function rejectionError(agent: CodexExecutionAgent, model: string): Error {
  try {
    assertExecutionModelSupported(agent, model);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error(`expected assertExecutionModelSupported to reject "${model}"`);
}

describe('CodexExecutionAgent model discovery outcomes', () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
  });

  it('uses healthy live output from a single probe', () => {
    stubProbes({ status: 0, stdout: catalog(LIVE_CATALOG_ENTRIES) });
    const agent = new CodexExecutionAgent();

    expect(agent.supportedModels).toEqual(expectedOptions(LIVE_CATALOG_ENTRIES));
    expect(agent.supportedModelsProvenance).toBe('agent');
    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(1);
    expect(probeArgs(0)).toEqual(['debug', 'models']);
  });

  it('falls back to the installed binary bundled catalog when the live probe exits nonzero', () => {
    stubProbes(
      { status: 23, stdout: '' },
      { status: 0, stdout: catalog(BUNDLED_CATALOG_ENTRIES) },
    );
    const agent = new CodexExecutionAgent({ command: '/opt/homebrew/bin/codex' });

    expect(agent.supportedModels).toEqual(expectedOptions(BUNDLED_CATALOG_ENTRIES));
    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(spawnSync).mock.calls[1]![0]).toBe('/opt/homebrew/bin/codex');
    expect(probeArgs(1)).toEqual(['debug', 'models', '--bundled']);
  });

  it('accepts a bundled-only model and still rejects an invented one', () => {
    stubProbes(
      { status: 23, stdout: '' },
      { status: 0, stdout: catalog(BUNDLED_CATALOG_ENTRIES) },
    );
    const agent = new CodexExecutionAgent();

    expect(agent.supportsModel('gpt-5.6-luna')).toBe(true);
    expect(() => assertExecutionModelSupported(agent, 'gpt-5.6-luna')).not.toThrow();
    expect(agent.supportsModel('gpt-5.9-invented')).toBe(false);
    expect(rejectionError(agent, 'gpt-5.9-invented').message).toContain('is not supported');
  });

  it('falls back to the bundled catalog when the live probe times out', () => {
    stubProbes(
      { status: null, signal: 'SIGKILL', error: spawnError('ETIMEDOUT') },
      { status: 0, stdout: catalog(BUNDLED_CATALOG_ENTRIES) },
    );
    const agent = new CodexExecutionAgent();

    expect(agent.supportsModel('gpt-5.6-luna')).toBe(true);
    expect(probeArgs(1)).toEqual(['debug', 'models', '--bundled']);
  });

  it('bounds both probes with the discovery timeout', () => {
    stubProbes(
      { status: 1, stdout: '' },
      { status: 0, stdout: catalog(BUNDLED_CATALOG_ENTRIES) },
    );
    const agent = new CodexExecutionAgent();
    void agent.supportedModels;

    for (const call of vi.mocked(spawnSync).mock.calls) {
      const options = call[2] as { timeout?: number } | undefined;
      expect(options?.timeout).toBeGreaterThan(0);
      expect(options?.timeout).toBeLessThanOrEqual(10_000);
    }
  });

  it('keeps a valid empty live catalog authoritative without probing --bundled', () => {
    stubProbesBySource({
      live: { status: 0, stdout: catalog([]) },
      bundled: { status: 0, stdout: catalog(BUNDLED_CATALOG_ENTRIES) },
    });
    const agent = new CodexExecutionAgent();

    expect(discoverSupportedModels(agent)).toEqual({ kind: 'success', source: 'live', models: [] });
    expect(agent.supportedModels).toEqual([]);
    expect(agent.supportedModelsProvenance).toBe('agent');
    expect(bundledProbeCount()).toBe(0);
  });

  it.each([
    ['malformed JSON', 'not json at all'],
    ['an absent models field', JSON.stringify({ catalog: [] })],
    ['a non-array models value', JSON.stringify({ models: { slug: 'gpt-5.5' } })],
    ['a non-object entry', catalog(['gpt-5.5'])],
    ['a missing slug', catalog([{ display_name: 'GPT-5.5' }])],
    ['a non-string display_name', catalog([{ slug: 'gpt-5.5', display_name: 7 }])],
    ['an empty slug', catalog([{ slug: '   ', display_name: 'GPT-5.5' }])],
  ])('treats live output with %s as a failed probe and falls back', (_label, stdout) => {
    stubProbes(
      { status: 0, stdout },
      { status: 0, stdout: catalog(BUNDLED_CATALOG_ENTRIES) },
    );
    const agent = new CodexExecutionAgent();

    expect(agent.supportedModels).toEqual(expectedOptions(BUNDLED_CATALOG_ENTRIES));
    expect(probeArgs(1)).toEqual(['debug', 'models', '--bundled']);
  });

  it('reports malformed bundled output as unavailable rather than successful emptiness', () => {
    stubProbesBySource({
      live: { status: 1, stdout: '' },
      bundled: { status: 0, stdout: '{"models": [' },
    });
    const agent = new CodexExecutionAgent();
    const discovered = discoverSupportedModels(agent);

    expect(discovered.kind).toBe('unavailable');
    expect(discovered.kind === 'unavailable' && discovered.attempts.map((attempt) => attempt.source))
      .toEqual(['live', 'bundled']);
    expect(agent.supportedModelsProvenance).not.toBe('agent');
    expect(() => agent.supportsModel('gpt-5.6-luna')).toThrow(/unavailable/i);
  });

  it('ignores extra catalog metadata on otherwise valid entries', () => {
    stubProbes({
      status: 0,
      stdout: catalog([
        {
          slug: 'gpt-5.6-luna',
          display_name: 'GPT-5.6-Luna',
          description: 'Our most capable model for complex, demanding work.',
          default_reasoning_level: 'low',
          supported_reasoning_levels: [{ effort: 'low', description: 'Fast responses' }],
          visibility: 'list',
          supported_in_api: true,
          priority: 1,
          context_window: 400_000,
          availability_nux: null,
        },
      ]),
    });
    const agent = new CodexExecutionAgent();

    expect(agent.supportedModels).toEqual([{ id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' }]);
  });

  it('trims entries and removes case-insensitive duplicates', () => {
    stubProbes({
      status: 0,
      stdout: catalog([
        { slug: '  gpt-5.6-luna  ', display_name: '  GPT-5.6-Luna  ' },
        { slug: 'GPT-5.6-LUNA', display_name: 'Duplicate Luna' },
        { slug: 'gpt-5.5', display_name: 'GPT-5.5' },
      ]),
    });
    const agent = new CodexExecutionAgent();

    expect(agent.supportedModels).toEqual([
      { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
      { id: 'gpt-5.5', label: 'GPT-5.5' },
    ]);
    expect(agent.supportsModel('GPT-5.6-Luna')).toBe(true);
  });

  it('surfaces a discovery-unavailable error when the CLI binary is missing', () => {
    stubProbes(
      { status: null, error: spawnError('ENOENT') },
      { status: null, error: spawnError('ENOENT') },
    );
    const agent = new CodexExecutionAgent();
    const message = rejectionError(agent, 'gpt-5.6-luna').message;

    expect(message).toMatch(/unavailable/i);
    expect(message).not.toContain('is not supported');
    expect(message).toContain('ENOENT');
    expect(message).toContain('live');
    expect(message).toContain('bundled');
  });

  it('surfaces a discovery-unavailable error when the CLI rejects --bundled', () => {
    stubProbes(
      { status: 1, stdout: '' },
      { status: 2, stdout: '', stderr: "error: unexpected argument '--bundled' found" },
    );
    const agent = new CodexExecutionAgent();
    const message = rejectionError(agent, 'gpt-5.6-luna').message;

    expect(message).toMatch(/unavailable/i);
    expect(message).not.toContain('is not supported');
    expect(message).toContain('gpt-5.6-luna');
    expect(message).toContain('live');
    expect(message).toContain('bundled');
    expect(message).toMatch(/status 1/);
    expect(message).toMatch(/status 2/);
  });

  it('keeps unavailable diagnostics bounded and free of raw catalog payloads', () => {
    const noisyPayload = `{"models":[${'y'.repeat(40_000)}`;
    stubProbes(
      { status: 1, stdout: '' },
      { status: 0, stdout: noisyPayload },
    );
    const agent = new CodexExecutionAgent();
    const message = rejectionError(agent, 'gpt-5.6-luna').message;

    expect(message).toMatch(/unavailable/i);
    expect(message).not.toContain('is not supported');
    expect(message.length).toBeLessThan(500);
    expect(message).not.toContain('yyyy');
  });

  it('reuses the successful discovery cache across repeated reads', () => {
    stubProbes({ status: 0, stdout: catalog(LIVE_CATALOG_ENTRIES) });
    const agent = new CodexExecutionAgent();

    expect(agent.supportedModels).toEqual(expectedOptions(LIVE_CATALOG_ENTRIES));
    expect(agent.supportedModels).toEqual(expectedOptions(LIVE_CATALOG_ENTRIES));
    expect(agent.supportsModel('gpt-5.5')).toBe(true);
    expect(vi.mocked(spawnSync)).toHaveBeenCalledTimes(1);
  });
});
