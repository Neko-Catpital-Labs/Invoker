import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearCursorModelDiscoveryCacheForTests,
  discoverCursorPlanningModels,
  setCursorModelProbeRunnerForTests,
  type CursorModelProbeResult,
} from '../cursor-model-discovery.js';
import { listInAppPlanningPresets } from '../in-app-planner.js';

function okProbe(stdout: string): CursorModelProbeResult {
  return { status: 0, stdout, stderr: '', error: undefined, signal: null };
}

function failProbe(partial: Partial<CursorModelProbeResult>): CursorModelProbeResult {
  return {
    status: partial.status ?? 1,
    stdout: partial.stdout ?? '',
    stderr: partial.stderr ?? '',
    error: partial.error,
    signal: partial.signal ?? null,
  };
}

const SAMPLE_CATALOG = [
  'Available models',
  'auto - Auto  (default)',
  'claude-4.5-sonnet - Claude Sonnet 4.5',
  'gpt-5.3-codex - Codex 5.3',
  'brand-new-model - Brand New Model',
  'brand-new-model-fast - Brand New Model Fast',
  'gemini-3.1-pro - Gemini 3.1 Pro',
].join('\n');

describe('discoverCursorPlanningModels', () => {
  beforeEach(() => {
    clearCursorModelDiscoveryCacheForTests();
    setCursorModelProbeRunnerForTests(undefined);
  });

  afterEach(() => {
    clearCursorModelDiscoveryCacheForTests();
    setCursorModelProbeRunnerForTests(undefined);
  });

  it('returns ok models from list-models text output', async () => {
    setCursorModelProbeRunnerForTests(() => okProbe(SAMPLE_CATALOG));
    const outcome = await discoverCursorPlanningModels({ refresh: true });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.models.map((m) => m.id)).toEqual([
      'auto',
      'claude-4.5-sonnet',
      'gpt-5.3-codex',
      'brand-new-model',
      'brand-new-model-fast',
      'gemini-3.1-pro',
    ]);
  });

  it('caches successful discovery within the session TTL', async () => {
    let calls = 0;
    setCursorModelProbeRunnerForTests(() => {
      calls += 1;
      return okProbe(SAMPLE_CATALOG);
    });
    const first = await discoverCursorPlanningModels({ refresh: true, now: 1_000 });
    const second = await discoverCursorPlanningModels({ refresh: false, now: 2_000 });
    expect(first.kind).toBe('ok');
    expect(second.kind).toBe('ok');
    expect(calls).toBe(1);
  });

  it('refresh bypasses the cache', async () => {
    let calls = 0;
    setCursorModelProbeRunnerForTests(() => {
      calls += 1;
      return okProbe(SAMPLE_CATALOG);
    });
    await discoverCursorPlanningModels({ refresh: true, now: 1_000 });
    await discoverCursorPlanningModels({ refresh: true, now: 2_000 });
    expect(calls).toBe(2);
  });

  it('classifies missing CLI / spawn errors as failed', async () => {
    setCursorModelProbeRunnerForTests(() => failProbe({
      status: null,
      error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
    }));
    expect(await discoverCursorPlanningModels({ refresh: true })).toEqual({
      kind: 'failed',
      reason: expect.stringContaining('ENOENT'),
    });
  });

  it('classifies timeout signals as failed', async () => {
    setCursorModelProbeRunnerForTests(() => failProbe({ status: null, signal: 'SIGKILL' }));
    expect(await discoverCursorPlanningModels({ refresh: true })).toEqual({
      kind: 'failed',
      reason: 'timed out',
    });
  });

  it('classifies auth failures as failed', async () => {
    setCursorModelProbeRunnerForTests(() => failProbe({
      status: 1,
      stderr: 'Authentication required. Run cursor-agent login',
    }));
    expect(await discoverCursorPlanningModels({ refresh: true })).toEqual({
      kind: 'failed',
      reason: 'authentication required',
    });
  });

  it('classifies empty catalogs distinctly from failures', async () => {
    setCursorModelProbeRunnerForTests(() => okProbe('Available models\n\n'));
    expect(await discoverCursorPlanningModels({ refresh: true })).toEqual({ kind: 'empty' });
  });

  it('classifies malformed output as failed', async () => {
    setCursorModelProbeRunnerForTests(() => okProbe('not a model catalog'));
    expect(await discoverCursorPlanningModels({ refresh: true })).toMatchObject({
      kind: 'failed',
      reason: expect.stringContaining('unusable'),
    });
  });
});

describe('listInAppPlanningPresets hybrid Cursor discovery', () => {
  beforeEach(() => {
    clearCursorModelDiscoveryCacheForTests();
    setCursorModelProbeRunnerForTests(undefined);
  });

  afterEach(() => {
    clearCursorModelDiscoveryCacheForTests();
    setCursorModelProbeRunnerForTests(undefined);
  });

  it('marks curated models confirmed and appends More… for new ids', async () => {
    setCursorModelProbeRunnerForTests(() => okProbe(SAMPLE_CATALOG));
    const { options, cursorDiscovery } = await listInAppPlanningPresets({}, {
      isInstalled: (command) => command === 'cursor',
      refreshCursorModels: true,
    });
    expect(cursorDiscovery?.status).toBe('ok');
    expect(options.find((p) => p.key === 'cursor+claude')).toMatchObject({
      availability: 'confirmed',
      section: 'recommended',
      model: 'claude-4.5-sonnet',
    });
    expect(options.find((p) => p.key === 'cursor+brand-new-model')).toMatchObject({
      availability: 'confirmed',
      section: 'more',
      model: 'brand-new-model',
      label: 'Brand New Model',
    });
    expect(options.some((p) => p.model === 'brand-new-model-fast')).toBe(false);
  });

  it('filters More… models through enabledExecutionAgents', async () => {
    setCursorModelProbeRunnerForTests(() => okProbe(SAMPLE_CATALOG));
    const { options } = await listInAppPlanningPresets(
      { enabledExecutionAgents: ['claude'] },
      {
        isInstalled: (command) => command === 'cursor',
        refreshCursorModels: true,
      },
    );
    expect(options.find((p) => p.key === 'cursor+claude')).toMatchObject({
      availability: 'confirmed',
      section: 'recommended',
    });
    expect(options.some((p) => p.key === 'cursor+gemini-3.1-pro')).toBe(false);
    expect(options.some((p) => p.key === 'cursor+brand-new-model')).toBe(false);
  });

  it('keeps curated models as unavailable when discovery renames/removes them', async () => {
    setCursorModelProbeRunnerForTests(() => okProbe([
      'Available models',
      'auto - Auto',
      'totally-different - Totally Different',
    ].join('\n')));
    const { options, cursorDiscovery } = await listInAppPlanningPresets({}, {
      isInstalled: (command) => command === 'cursor',
      refreshCursorModels: true,
    });
    expect(cursorDiscovery?.status).toBe('ok');
    expect(options.find((p) => p.key === 'cursor+claude')).toMatchObject({
      availability: 'unavailable',
      section: 'recommended',
      model: 'claude-4.5-sonnet',
    });
    expect(options.some((p) => p.key === 'cursor+claude')).toBe(true);
  });

  it('falls back to unverified curated models when discovery fails', async () => {
    setCursorModelProbeRunnerForTests(() => failProbe({
      status: null,
      error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
    }));
    const { options, cursorDiscovery } = await listInAppPlanningPresets({}, {
      isInstalled: (command) => command === 'cursor',
      refreshCursorModels: true,
    });
    expect(cursorDiscovery?.status).toBe('failed');
    expect(cursorDiscovery?.warning).toMatch(/Could not verify Cursor models/);
    expect(options.find((p) => p.key === 'cursor+claude')?.availability).toBe('unverified');
    expect(options.some((p) => p.section === 'more')).toBe(false);
  });

  it('distinguishes empty discovery from failure', async () => {
    setCursorModelProbeRunnerForTests(() => okProbe('Available models\n'));
    const { cursorDiscovery } = await listInAppPlanningPresets({}, {
      isInstalled: (command) => command === 'cursor',
      refreshCursorModels: true,
    });
    expect(cursorDiscovery?.status).toBe('empty');
    expect(cursorDiscovery?.warning).toMatch(/no models/i);
  });

  it('skips discovery when Cursor is not among available tools', async () => {
    const { cursorDiscovery } = await listInAppPlanningPresets({}, {
      isInstalled: (command) => command === 'codex',
      refreshCursorModels: true,
    });
    expect(cursorDiscovery?.status).toBe('skipped');
  });
});
