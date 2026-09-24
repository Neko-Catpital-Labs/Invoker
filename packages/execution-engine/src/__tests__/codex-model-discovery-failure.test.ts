import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertExecutionModelSupported,
  isExecutionModelDiscoveryUnavailableError,
  type ExecutionModelOption,
} from '../agent.js';
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
  | { kind: 'failed'; failures: readonly { attempt: string; detail: string }[] };

type ModelDiscoveryTestAccess = {
  discoverSupportedModels(): ModelDiscoveryResult;
};

function discoverSupportedModels(agent: CodexExecutionAgent): ModelDiscoveryResult {
  return (agent as unknown as ModelDiscoveryTestAccess).discoverSupportedModels();
}

const LIVE_CATALOG = {
  models: [
    {
      slug: 'gpt-6-astra',
      display_name: 'GPT-6-Astra',
      description: 'Our most capable model for complex, demanding work.',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [{ effort: 'low', description: 'Fast responses with lighter reasoning' }],
      visibility: 'list',
      supported_in_api: true,
      priority: 1,
      context_window: 400_000,
    },
    { slug: 'gpt-reserve', display_name: 'GPT-Reserve' },
    { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol' },
    { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra' },
    { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna' },
    { slug: 'gpt-5.5', display_name: 'GPT-5.5' },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review' },
  ],
};

const LIVE_MODELS: ExecutionModelOption[] = [
  { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
  { id: 'gpt-reserve', label: 'GPT-Reserve' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'codex-auto-review', label: 'Codex Auto Review' },
];

const BUNDLED_CATALOG = {
  models: [
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
  ],
};

const LIVE_ARGS = ['debug', 'models'];
const BUNDLED_ARGS = ['debug', 'models', '--bundled'];

type ProbeOverrides = {
  status?: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
  signal?: NodeJS.Signals | null;
};

function probe(overrides: ProbeOverrides = {}) {
  return {
    status: 0,
    stdout: '',
    stderr: '',
    output: [],
    pid: 1,
    signal: null,
    ...overrides,
  } as any;
}

function ok(catalog: unknown) {
  return probe({ status: 0, stdout: JSON.stringify(catalog) });
}

function exitedWith(status: number, stderr = '') {
  return probe({ status, stdout: '', stderr });
}

function spawnFailure(code: string) {
  const error = Object.assign(new Error(`spawnSync ${code}`), { code });
  return probe({ status: null, error });
}

function stubProbes(...results: unknown[]): void {
  const mocked = vi.mocked(spawnSync);
  for (const result of results) mocked.mockReturnValueOnce(result as never);
  mocked.mockReturnValue(exitedWith(127) as never);
}

function probeArgs(): string[][] {
  return vi.mocked(spawnSync).mock.calls.map((call) => [...(call[1] as string[])]);
}

function rejection(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('expected the call to throw');
}

describe('CodexExecutionAgent model discovery outcomes', () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
  });

  it('uses a healthy live catalog after a single probe', () => {
    stubProbes(ok(LIVE_CATALOG));
    const agent = new CodexExecutionAgent();

    expect(agent.supportedModels).toStrictEqual(LIVE_MODELS);
    expect(agent.supportedModelsProvenance).toBe('agent');
    expect(probeArgs()).toEqual([LIVE_ARGS]);
  });

  it('ignores extra real catalog metadata when parsing live entries', () => {
    stubProbes(ok(LIVE_CATALOG));
    const agent = new CodexExecutionAgent();

    expect(agent.supportedModels[0]).toEqual({ id: 'gpt-6-astra', label: 'GPT-6-Astra' });
  });

  it('falls back to the bundled catalog of the same binary when the live probe exits nonzero', () => {
    stubProbes(exitedWith(23), ok(BUNDLED_CATALOG));
    const agent = new CodexExecutionAgent({ command: '/usr/bin/codex' });

    expect(agent.supportsModel('gpt-5.6-luna')).toBe(true);
    expect(agent.supportsModel('gpt-5.9-invented')).toBe(false);
    expect(probeArgs()).toEqual([LIVE_ARGS, BUNDLED_ARGS]);
    expect(vi.mocked(spawnSync).mock.calls.map((call) => call[0])).toEqual(['/usr/bin/codex', '/usr/bin/codex']);
  });

  it('accepts a bundled-only model through assertExecutionModelSupported and still rejects an invented id', () => {
    stubProbes(spawnFailure('ETIMEDOUT'), ok(BUNDLED_CATALOG));
    const agent = new CodexExecutionAgent();

    expect(() => assertExecutionModelSupported(agent, 'gpt-5.6-luna')).not.toThrow();
    expect(rejection(() => assertExecutionModelSupported(agent, 'gpt-5.9-invented')).message)
      .toContain('is not supported for execution agent "codex"');
  });

  it('bounds both probes with the same timeout and kill signal', () => {
    stubProbes(exitedWith(1), ok(BUNDLED_CATALOG));
    const agent = new CodexExecutionAgent();
    void agent.supportedModels;

    const options = vi.mocked(spawnSync).mock.calls.map((call) => call[2] as Record<string, unknown>);
    expect(options).toHaveLength(2);
    for (const option of options) {
      expect(option.timeout).toBe(3_000);
      expect(option.killSignal).toBe('SIGKILL');
    }
  });

  it('keeps a valid empty live catalog authoritative without probing the bundled catalog', () => {
    stubProbes(ok({ models: [] }));
    const agent = new CodexExecutionAgent();

    expect(agent.supportedModels).toEqual([]);
    expect(probeArgs()).toEqual([LIVE_ARGS]);
  });

  it('represents a valid empty live catalog as a successful discovery', () => {
    stubProbes(ok({ models: [] }));
    const agent = new CodexExecutionAgent();

    expect(discoverSupportedModels(agent)).toEqual({ kind: 'success', models: [] });
  });

  it.each([
    ['malformed JSON', probe({ status: 0, stdout: '{"models": [' })],
    ['an absent models field', ok({ catalog_version: 7 })],
    ['a non-array models value', ok({ models: { 'gpt-5.5': 'GPT-5.5' } })],
    ['an entry missing display_name', ok({ models: [{ slug: 'gpt-5.5' }] })],
    ['an entry with a non-string slug', ok({ models: [{ slug: 12, display_name: 'GPT-5.5' }] })],
    ['an entry that is not an object', ok({ models: ['gpt-5.5'] })],
  ])('falls back to the bundled catalog when the live probe returns %s', (_label, liveResult) => {
    stubProbes(liveResult, ok(BUNDLED_CATALOG));
    const agent = new CodexExecutionAgent();

    expect(agent.supportsModel('gpt-5.6-luna')).toBe(true);
    expect(probeArgs()).toEqual([LIVE_ARGS, BUNDLED_ARGS]);
  });

  it('reports malformed bundled output as unavailable rather than successful emptiness', () => {
    stubProbes(exitedWith(1), probe({ status: 0, stdout: 'not json at all' }));
    const agent = new CodexExecutionAgent();

    const error = rejection(() => agent.supportedModels);
    expect(error.message).toContain('Codex model discovery');
    expect(error.message).toContain('unavailable');
    expect(error.message).toMatch(/bundled/);
  });

  it('represents total discovery failure distinctly with a diagnostic per attempt', () => {
    stubProbes(spawnFailure('ETIMEDOUT'), exitedWith(2, 'error: unexpected argument --bundled'));
    const agent = new CodexExecutionAgent();

    expect(discoverSupportedModels(agent)).toEqual({
      kind: 'failed',
      failures: [
        { attempt: 'live', detail: expect.stringContaining('ETIMEDOUT') },
        { attempt: 'bundled', detail: expect.stringContaining('2') },
      ],
    });
  });

  it('surfaces a discovery-unavailable error when the CLI binary is missing', () => {
    stubProbes(spawnFailure('ENOENT'), spawnFailure('ENOENT'));
    const agent = new CodexExecutionAgent();

    const error = rejection(() => assertExecutionModelSupported(agent, 'gpt-5.6-luna'));
    expect(error.message).toContain('unavailable');
    expect(error.message).toContain('ENOENT');
    expect(error.message).not.toContain('is not supported for execution agent');
  });

  it('tags the discovery-unavailable error so read-only callers can classify it', () => {
    stubProbes(spawnFailure('ENOENT'), spawnFailure('ENOENT'));
    const agent = new CodexExecutionAgent();

    expect(isExecutionModelDiscoveryUnavailableError(rejection(() => agent.supportedModels))).toBe(true);
    expect(isExecutionModelDiscoveryUnavailableError(
      rejection(() => assertExecutionModelSupported(agent, 'gpt-5.6-luna')),
    )).toBe(true);
  });

  it('leaves a genuine unsupported-model rejection unclassified as a discovery failure', () => {
    stubProbes(ok(LIVE_CATALOG));
    const agent = new CodexExecutionAgent();

    expect(isExecutionModelDiscoveryUnavailableError(
      rejection(() => assertExecutionModelSupported(agent, 'gpt-5.9-invented')),
    )).toBe(false);
  });

  it('surfaces a discovery-unavailable error when the CLI rejects --bundled', () => {
    stubProbes(exitedWith(1), exitedWith(2, 'error: unexpected argument --bundled'));
    const agent = new CodexExecutionAgent();

    const error = rejection(() => agent.supportedModels);
    expect(error.message).toContain('live');
    expect(error.message).toContain('bundled');
    expect(error.message.length).toBeLessThan(400);
  });

  it('never echoes probe payloads into discovery diagnostics', () => {
    const secret = 'OPENAI_API_KEY=sk-live-should-never-appear';
    stubProbes(probe({ status: 0, stdout: `${secret} <<<not json>>>` }), probe({ status: 0, stdout: secret }));
    const agent = new CodexExecutionAgent();

    expect(rejection(() => agent.supportedModels).message).not.toContain('sk-live');
  });

  it('trims ids and labels and removes case-insensitive duplicates', () => {
    stubProbes(ok({
      models: [
        { slug: '  gpt-5.6-luna  ', display_name: '  GPT-5.6-Luna  ' },
        { slug: 'GPT-5.6-LUNA', display_name: 'Duplicate Luna' },
        { slug: 'gpt-5.5', display_name: 'GPT-5.5' },
      ],
    }));
    const agent = new CodexExecutionAgent();

    expect(agent.supportedModels).toEqual([
      { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
      { id: 'gpt-5.5', label: 'GPT-5.5' },
    ]);
  });

  it('reuses the successful discovery cache across repeated reads', () => {
    stubProbes(ok(LIVE_CATALOG));
    const agent = new CodexExecutionAgent();

    expect(agent.supportedModels).toStrictEqual(LIVE_MODELS);
    expect(agent.supportsModel('gpt-5.6-luna')).toBe(true);
    expect(agent.supportedModelsProvenance).toBe('agent');
    expect(probeArgs()).toEqual([LIVE_ARGS]);
  });

  it('caches a total discovery failure instead of respawning both probes on every read', () => {
    stubProbes(spawnFailure('ENOENT'), spawnFailure('ENOENT'));
    const agent = new CodexExecutionAgent();

    const first = rejection(() => agent.supportedModels);
    const second = rejection(() => agent.supportsModel('gpt-5.6-luna'));
    const third = rejection(() => agent.supportedModelsProvenance);

    expect(probeArgs()).toEqual([LIVE_ARGS, BUNDLED_ARGS]);
    for (const error of [first, second, third]) {
      expect(error.name).toBe('CodexModelDiscoveryUnavailableError');
      expect(error.message).toContain('live probe failed to run (ENOENT)');
      expect(error.message).toContain('bundled probe failed to run (ENOENT)');
    }
  });

  it('probes again once a cached failure expires and adopts the recovered catalog', () => {
    stubProbes(spawnFailure('ENOENT'), spawnFailure('ENOENT'), ok(LIVE_CATALOG));
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      const agent = new CodexExecutionAgent();

      rejection(() => agent.supportedModels);
      expect(probeArgs()).toEqual([LIVE_ARGS, BUNDLED_ARGS]);

      nowSpy.mockReturnValue(5 * 60_000 + 1);
      expect(agent.supportedModels).toStrictEqual(LIVE_MODELS);
      expect(probeArgs()).toEqual([LIVE_ARGS, BUNDLED_ARGS, LIVE_ARGS]);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
