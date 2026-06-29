import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterAll, beforeAll } from 'vitest';

import { DEFAULT_TOOL_REQUIREMENTS } from '@invoker/contracts';

import { collectSystemDiagnostics, commandIsOnPath, detectTool } from '../system-diagnostics.js';

/**
 * Regression for the deterministic Electron main-thread wedge observed
 * 2026-06-04: `spawnSync('docker', ['--version'])` blocked forever when
 * Docker Desktop was installed but not running, which froze the renderer
 * IPC handler `invoker:get-system-diagnostics` and consequently every
 * other timer, IPC, and HTTP request on the main thread.
 *
 * The fix is the 3000ms `timeout` + SIGKILL on `spawnSync` inside
 * `detectTool`. This test simulates a hanging CLI with a small shell
 * script that sleeps for 60 seconds, and asserts:
 *   1. detectTool returns within 4 seconds (well under 60s)
 *   2. it returns `installed: false` for the hung tool (because we cannot
 *      verify the binary works if it never replies)
 */
describe('detectTool — main-thread hang protection', () => {
  let scratchDir: string;
  let hangingCli: string;

  beforeAll(() => {
    scratchDir = mkdtempSync(path.join(tmpdir(), 'invoker-syscall-diag-'));
    hangingCli = path.join(scratchDir, 'fake-hanging-cli');
    writeFileSync(
      hangingCli,
      '#!/usr/bin/env bash\nsleep 60\nexit 0\n',
      'utf8',
    );
    chmodSync(hangingCli, 0o755);
  });

  afterAll(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('returns within ~3s when the CLI hangs (the Electron-wedge regression)', () => {
    const startedAt = Date.now();
    const result = detectTool(
      'fake',
      'Fake CLI',
      hangingCli,
      ['--version'],
      'irrelevant install hint',
    );
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(4000);
    expect(result.installed).toBe(false);
    expect(result.id).toBe('fake');
  }, 6000);

  it('still returns a populated version for a working CLI', () => {
    const result = detectTool(
      'node',
      'Node.js',
      'node',
      ['--version'],
      'irrelevant install hint',
    );
    expect(result.installed).toBe(true);
    expect(result.version).toMatch(/^v\d+/);
  }, 5000);
});

const baseArgs = {
  appVersion: '0.0.0-test',
  isPackaged: false,
  platform: 'linux' as NodeJS.Platform,
  arch: 'x64',
};

describe('commandIsOnPath — non-spawning PATH probe', () => {
  it('resolves a binary present on PATH and rejects a missing one', () => {
    // `node` is always on PATH while the test runner executes.
    expect(commandIsOnPath('node')).toBe(true);
    expect(commandIsOnPath('definitely-not-a-real-binary-xyz')).toBe(false);
  });

  it('honors an injected PATH and finds nothing when PATH is empty', () => {
    expect(commandIsOnPath('node', { PATH: '' })).toBe(false);
  });
});

describe('collectSystemDiagnostics — shared canonical contract', () => {
  it('builds the tools array from DEFAULT_TOOL_REQUIREMENTS', () => {
    const diag = collectSystemDiagnostics(baseArgs);
    expect(diag.tools.map((t) => t.id)).toEqual(DEFAULT_TOOL_REQUIREMENTS.map((r) => r.id));
    expect(diag.tools.map((t) => t.name)).toEqual(DEFAULT_TOOL_REQUIREMENTS.map((r) => r.name));
  });

  it('assembles a config-aware readiness report with config, planning-tools, and default-preset checks', () => {
    const diag = collectSystemDiagnostics({
      ...baseArgs,
      config: { path: '/tmp/invoker-nonexistent/config.json', exists: false },
      presets: { 'cursor+claude': { tool: 'cursor', model: 'claude' } },
      defaultPreset: 'cursor+claude',
    });
    const ids = diag.readiness.map((c) => c.id);
    expect(ids).toContain('config');
    expect(ids).toContain('planning-tools');
    expect(ids).toContain('default-preset');
    // Readiness tool checks mirror the same canonical contract as the tools array.
    for (const req of DEFAULT_TOOL_REQUIREMENTS) expect(ids).toContain(req.id);
  });

  it('skips the preset checks when no presets are configured', () => {
    const diag = collectSystemDiagnostics({
      ...baseArgs,
      config: { path: '/tmp/invoker-nonexistent/config.json', exists: false },
    });
    const ids = diag.readiness.map((c) => c.id);
    expect(ids).toContain('config');
    expect(ids).not.toContain('planning-tools');
    expect(ids).not.toContain('default-preset');
  });
});
